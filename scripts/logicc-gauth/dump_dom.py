# -*- coding: utf-8 -*-
"""科研工具：打开页面并 dump 全部交互控件（tag/id/class/role/text/坐标）。"""
import json
import sys

from patchright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "https://app.logicc.com/login"

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=False,
                                args=["--no-first-run", "--no-default-browser-check", "--lang=en-US"])
    ctx = browser.new_context(locale="en-US")
    page = ctx.new_page()
    page.goto(URL, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(6000)
    dump = page.evaluate(r"""() => {
      const vis = el => { const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0; };
      const out = { url: location.href.slice(0, 100),
                    title: document.title,
                    lang: document.documentElement.lang,
                    controls: [] };
      for (const el of document.querySelectorAll('button, input, select, a[href], [role]')) {
        if (!vis(el)) continue;
        const r = el.getBoundingClientRect();
        out.controls.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          name: el.name || null,
          type: el.type || null,
          role: el.getAttribute('role'),
          cls: String(el.className).slice(0, 70),
          text: (el.innerText || el.value || '').slice(0, 40).replace(/\n/g, ' '),
          xy: [Math.round(r.x + r.width/2), Math.round(r.y + r.height/2)],
        });
      }
      out.controls.sort((a, b) => (a.xy[1] - b.xy[1]) || (a.xy[0] - b.xy[0]));
      return out;
    }""")
    print(json.dumps(dump, ensure_ascii=False, indent=1))
    print("\n浏览器保持打开（关掉此进程或按 Ctrl+C 结束）")
    try:
        import time
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
