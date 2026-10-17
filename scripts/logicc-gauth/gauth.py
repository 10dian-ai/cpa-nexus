# -*- coding: utf-8 -*-
"""logicc-gauth v4：Logicc Google OAuth 全程自动开号机（页面状态驱动版）。

方法论（与操作者共同验证）：JS 当眼睛——每步整页判断真实 DOM 状态；
结构规律判定目标（不猜文案）；CDP 坐标当手（trusted 事件）；一步一验。

全程（2026-10-17 实测固化）：
  Logicc 登录页 → Google OAuth（邮箱→密码→TOTP→consent[同行x最大=确认]）
  → Logicc 条款页（role=checkbox 勾选→Continue）
  → onboarding（姓名预填→行业/规模下拉→公司名→Continue）
  → 主界面 → __client 收割（Clerk API 查 sid）→ 让出会话。

连接已开的调试 Chrome（127.0.0.1:9222），全程不关浏览器。
用法：
  python gauth.py 账号.json            # 注册/登录自适应（未注册自动走注册）
  python gauth.py 账号.json --dry      # 只跑到授权页停下（人工接管）
产出 accounts-out/<label>.json：{"name","sessionId","clientCookie"}（CPAN/logicc2api 通用格式）。
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

import pyotp
from patchright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9222"
APP = "https://app.logicc.com"
CLERK = "https://clerk.logicc.com"

# ---------- 眼睛：整页判断 ----------

PAGE_JS = r"""(() => {
  try {
  const vis = el => { try { const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0; } catch (e) { return false; } };
  const center = el => { const r = el.getBoundingClientRect();
    return [Math.round(r.x + r.width/2), Math.round(r.y + r.height/2)]; };
  const out = { url: (location.href || '').slice(0, 120),
    text: ((document.body || {}).innerText || '').slice(0, 200),
    controls: [] };
  for (const el of document.querySelectorAll('button, input, select, [role=option], [role=checkbox], [role=combobox], a[href]')) {
    if (!el || !vis(el)) continue;
    out.controls.push({
      tag: (el.tagName || '').toLowerCase(), id: el.id || null, type: el.type || null,
      role: el.getAttribute('role'), name: el.name || null,
      value: (el.value !== undefined && el.value !== '' ? String(el.value).slice(0, 40) : null),
      text: ((el.innerText || el.placeholder || el.value || '') + '').slice(0, 40).replace(/\n/g, ' '),
      checked: el.checked === undefined ? null : el.checked,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      xy: center(el),
    });
  }
  return out;
  } catch (e) { return { url: '', text: 'eval-error: ' + String(e).slice(0, 80), controls: [] }; }
})()"""

CONSENT_JS = r"""(() => {  // Google 设计规范：同行按钮 x 最大 = 确认键（跨语言）
  const b = [...document.querySelectorAll('button')].filter(e => {
    const r = e.getBoundingClientRect(); return r.width > 0; });
  if (!b.length) return null;
  const lines = {};
  for (const e of b) {
    const r = e.getBoundingClientRect();
    const y = Math.round(r.y + r.height / 2);
    const k = Object.keys(lines).find(k => Math.abs(k - y) < 20) || y;
    (lines[k] = lines[k] || []).push({ e, x: Math.round(r.x + r.width / 2),
      t: (e.innerText || '').slice(0, 25) });
  }
  const main = Object.values(lines).sort((a, c) => c.length - a.length)[0];
  const target = main.sort((a, c) => a.x - c.x)[main.length - 1];
  const r = target.e.getBoundingClientRect();
  return { text: target.t, x: target.x, y: Math.round(r.y + r.height / 2) };
})()"""


class GAuthError(Exception):
    def __init__(self, reason, message):
        super().__init__(message)
        self.reason = reason  # needs_human / bad_credentials / transient


def look(page, verbose=True):
    """整页判断：拉 URL + 文本 + 全部控件；页面变化时打印。"""
    last = getattr(look, "_last", "")
    snap = page.evaluate(PAGE_JS)
    if not snap["controls"]:
        return snap
    fp = snap["url"].split("?")[0] + "|" + "|".join(
        f"{c['tag']}#{c['id'] or c['name'] or c['type'] or '-'}:{c['text'][:15]}" for c in snap["controls"])
    if verbose and fp != last:
        look._last = fp
        print(f"  [page] {snap['url'].split('?')[0][:80]}")
        for c in snap["controls"]:
            flag = (" 🚫禁用" if c["disabled"] else "") + (" ☑" if c["checked"] else "")
            print(f"    {c['tag']:<7} {str(c['id'] or c['name'] or c['type'] or '-'):<24}"
                  f" ({c['xy'][0]:>3},{c['xy'][1]:>3}) \"{c['text']}\"{flag}")
    return snap


def find(snap, **kw):
    """控件查找：全部条件精确匹配；坐标 (0~5) 边缘的隐藏元素排除。"""
    for c in snap["controls"]:
        if c["xy"][0] < 6 or c["xy"][1] < 6:
            continue  # 视口外隐藏元素（如原生 checkbox 移出屏幕）
        for k, v in kw.items():
            if c.get(k) != v:
                break
        else:
            return c
    return None


def click(page, c, label=""):
    page.mouse.click(c["xy"][0], c["xy"][1])
    print(f"  [点] ({c['xy'][0]},{c['xy'][1]}) {label or c['tag']} \"{c['text'][:20]}\"")


def type_into(page, c, text, label=""):
    page.mouse.click(c["xy"][0], c["xy"][1])
    time.sleep(0.3)
    page.keyboard.type(text, delay=45)
    print(f"  [输入] {label} ← \"{text[:30]}\"")


def pick(page, snap, combo_kw, want, nudge_xy=None):
    """下拉选择：点开 combobox → 找含 want 的选项 → 点选。返回是否成功。"""
    combo = find(snap, **combo_kw)
    if not combo:
        return False
    click(page, combo, f"下拉:{combo_kw}")
    time.sleep(2)
    opts = page.evaluate(r"""(() => {const rows=[];for(const el of document.querySelectorAll('[role=option], [role=menuitem]')){
      const r=el.getBoundingClientRect();if(r.width<=0)continue;rows.push({t:(el.innerText||'').slice(0,35),
      x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}return rows;})()""")
    hit = next((o for o in opts if want.lower() in o["t"].lower()), None)
    if not hit:
        print(f"  [下拉] 未找到 \"{want}\"，可选 {[o['t'][:15] for o in opts[:6]]}")
        page.keyboard.press("Escape")
        return False
    page.mouse.click(hit["x"], hit["y"])
    print(f"  [下拉] 选 \"{hit['t'][:25]}\"")
    time.sleep(1.5)
    return True


def google_flow(page, account, dry=False):
    """Google 侧：OAuth 到离开 google 域。页面状态驱动，一步一验。"""
    email, password, totp = account["googleEmail"], account["googlePassword"], account["totpSecret"]
    did = set()
    deadline = time.time() + 150
    while time.time() < deadline:
        snap = look(page)
        url = snap["url"]

        if "accounts.google.com" not in url:
            return  # Google 侧完成

        if "/signin/oauth" in url:
            if dry:
                print("  [dry] 停在授权页，等人工")
                return "dry_stop"
            t = page.evaluate(CONSENT_JS)
            if t:
                print(f"  [consent] 点 \"{t['text']}\" ({t['x']},{t['y']})")
                page.mouse.click(t["x"], t["y"])
            time.sleep(4); continue

        if "totp" in url:
            code = pyotp.TOTP(totp).now()
            if "totp" not in did:
                box = (find(snap, tag="input", type="tel") or find(snap, tag="input", id="totpPin"))
                if box:
                    did.add("totp")
                    type_into(page, box, code, "TOTP")
                    page.keyboard.press("Enter")
            time.sleep(4); continue

        if "/pwd" in url:
            if "pwd" not in did:
                box = (find(snap, tag="input", id="password") or find(snap, tag="input", type="password"))
                if box:
                    did.add("pwd")
                    type_into(page, box, password, "密码")
                    page.keyboard.press("Enter")
            time.sleep(4); continue

        if "identifier" in url:
            if "id" not in did:
                box = (find(snap, tag="input", id="identifierId") or find(snap, tag="input", type="email"))
                if box:
                    did.add("id")
                    type_into(page, box, email, "邮箱")
                    page.keyboard.press("Enter")
            time.sleep(4); continue
        time.sleep(2)
    raise GAuthError("transient", "Google 流程超时: " + page.url[:70])


def logicc_flow(page, account, dry=False):
    """Logicc 侧：登录页/条款页/onboarding → 主界面。状态驱动，一步一验。"""
    deadline = time.time() + 180
    while time.time() < deadline:
        snap = look(page)
        url = snap["url"]

        # 主界面（完成标志）
        if "app.logicc.com" in url and not any(p in url for p in ("/login", "/register", "/sso-callback", "/onboarding")):
            return "main_app"

        # 登录/注册页：点 Continue with Google（Logicc 站固定英文界面）。
        # 关键：点击后等跳转完成再重新评估——重复点击会作废 sign_in 尝试导致回弹。
        if "/login" in url or "/register" in url:
            g = find(snap, tag="button", text="Continue with Google")
            if g:
                click(page, g, "Continue with Google")
                waited = 0
                while waited < 25:
                    time.sleep(1); waited += 1
                    cur = page.url
                    if ("/login" not in cur and "/register" not in cur) or "sso-callback" in cur:
                        break
                time.sleep(2)
                google_flow(page, account, dry=dry)  # Google 侧状态机（处理到离开 Google）
                if dry:
                    return "dry_stop"
            time.sleep(3); continue

        # sso-callback / Google 域：交给 Google 状态机（处理到离开 Google）
        if "sso-callback" in url or "accounts.google.com" in url:
            google_flow(page, account, dry=dry)
            if dry:
                return "dry_stop"
            time.sleep(3); continue

        # 条款页（Terms/Privacy + role=checkbox + Continue）
        checkbox = find(snap, role="checkbox")
        if checkbox is not None and "app.logicc.com" in url and checkbox.get("checked") is not True:
            click(page, checkbox, "条款复选框")
            time.sleep(1.5); continue
        if checkbox is not None and checkbox.get("checked") is True:
            cont = find(snap, tag="button", type="submit", text="Continue", disabled=False) \
                or find(snap, tag="button", text="Continue", disabled=False)
            if cont:
                click(page, cont, "条款Continue")
                time.sleep(5); continue

        # onboarding：JS 判断表单缺什么补什么
        if "/onboarding" in url:
            first = find(snap, tag="input", name="firstName")
            last = find(snap, tag="input", name="lastName")
            company = find(snap, tag="input", name="companyLegalName")
            if first and not first.get("value"):
                type_into(page, first, account.get("firstName") or "Alex", "名")
            elif last and not last.get("value"):
                type_into(page, last, account.get("lastName") or "Kim", "姓")
            elif company and not company.get("value"):
                type_into(page, company, account.get("company") or (account["label"] + " Systems"), "公司名")
            else:
                industry = find(snap, role="combobox", text="Select an industry")
                if industry:
                    pick(page, snap, {"role": "combobox", "text": "Select an industry"}, "Software and IT")
                    continue
                size = find(snap, role="combobox", text="Select company size")
                if size:
                    pick(page, snap, {"role": "combobox", "text": "Select company size"}, "Just me")
                    continue
                cont = find(snap, tag="button", type="submit", text="Continue", disabled=False)
                if cont:
                    click(page, cont, "onboarding Continue")
                    time.sleep(6); continue
            time.sleep(2); continue

        time.sleep(3)
    raise GAuthError("transient", "Logicc 流程超时: " + page.url[:70])


def harvest(page, label):
    """收割：window.Clerk 优先，失败用 __client 调 Clerk API 查会话。"""
    info = {}
    for _ in range(3):
        info = page.evaluate("() => ({ sid: window.Clerk?.session?.id || null })")
        if info.get("sid"):
            break
        time.sleep(2)
    sid = info.get("sid")
    cookies = page.context.cookies(["https://clerk.logicc.com"])
    client = next((c["value"] for c in cookies if c["name"] == "__client"), None)
    if not sid and client:  # Clerk API 兜底（页面对象未就绪时）
        req = urllib.request.Request(
            CLERK + "/v1/client?__clerk_api_version=2026-05-12",
            headers={"Cookie": "__client=" + client,
                     "User-Agent": "Mozilla/5.0", "Origin": APP})
        with urllib.request.urlopen(req, timeout=20) as r:
            j = json.loads(r.read().decode())
        sessions = (j.get("response") or {}).get("sessions") or (j.get("client") or {}).get("sessions") or []
        sid = next((s["id"] for s in sessions if s.get("status") == "active"), None)
    if not sid or not client:
        raise GAuthError("transient", f"收割失败 sid={sid} client={bool(client)}")
    out = {"name": label, "sessionId": sid, "clientCookie": client}
    out_dir = Path(__file__).parent / "accounts-out"
    out_dir.mkdir(exist_ok=True)
    (out_dir / f"{label}.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    page.goto("about:blank")  # 让出会话（防 __client 竞争轮换）
    return out


def main():
    dry = "--dry" in sys.argv
    account = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
    if "accounts" in account:
        account = account["accounts"][0]
    # 脚本自己拉起浏览器（生命周期全在脚本内）；--cdp 才连接外部已开的调试 Chrome
    with sync_playwright() as p:
        if "--cdp" in sys.argv:
            browser = p.chromium.connect_over_cdp(CDP)
            ctx = browser.contexts[0]
            pages = [pg for pg in ctx.pages if not pg.url.startswith("devtools://")]
            page = pages[0] if pages else ctx.new_page()
        else:
            browser = p.chromium.launch(channel="chrome", headless=False,
                args=["--no-first-run", "--no-default-browser-check", "--lang=en-US"])
            ctx = browser.new_context(locale="en-US")
            page = ctx.new_page()
        print(f"[{account['label']}] 浏览器已就绪（{'CDP 复用' if '--cdp' in sys.argv else '脚本自起'}）")
        page.goto(APP + "/login")
        page.wait_for_timeout(2000)
        # 醒目标记：让操作者一眼认出哪个窗口是脚本在操作
        page.evaluate("""() => {
            document.title = "🤖 [脚本窗口] " + document.title;
            const banner = document.createElement("div");
            banner.textContent = "🤖 此窗口由 logicc-gauth 自动化脚本操作";
            banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
                "background:#e11;color:#fff;font-size:18px;font-weight:bold;padding:8px;text-align:center";
            document.body.prepend(banner);
        }""")
        page.wait_for_timeout(3000)
        result = logicc_flow(page, account, dry=dry)
        print(f"[{account['label']}] 阶段结果: {result}")
        if result == "stopped_at_consent":
            print("浏览器停在授权页等人工，测完去掉 --dry 重跑。")
            return
        out = harvest(page, account["label"])
        print(f"[{account['label']}] 🎉 凭证已存 accounts-out/{account['label']}.json"
              f"（sessionId={out['sessionId'][:16]}…）会话已让出")


if __name__ == "__main__":
    main()
