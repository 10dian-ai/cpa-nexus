# -*- coding: utf-8 -*-
"""logicc-gauth 小内核 HTTP 服务：把 gauth.py 的全程 OAuth 能力暴露给 CPAN。

定位：CPAN Logicc 模块的「模块小内核」——独立容器、独立进程，只通过
HTTP 与模块交互；gauth.py 的全部功能（登录/注册自适应、--dry、批量、
needs_human 纪律、accounts-out 落盘）原样保留，CLI 用法不变。

接口（默认端口 GAUTH_PORT=8320，仅 compose 内网可达）：
  GET  /health    → {"ok": true, "busy": bool}
  POST /v1/login  → {"label","googleEmail","googlePassword","totpSecret",
                     "firstName?","lastName?","company?"}
                 → {"ok": true, "name", "sessionId", "clientCookie"}
                    {"ok": false, "reason": "needs_human|bad_credentials|transient|busy", "message"}

纪律（沿用 gauth.py）：同一时刻只跑一个浏览器流程（单飞），并发请求收到
busy 让模块稍后重试；Google 侧出现不认识的挑战立即停、报 needs_human，
绝不绕过。一个 __client 只给号池用：收割后立即让出会话。
"""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from patchright.sync_api import sync_playwright

import gauth

PORT = int(os.environ.get("GAUTH_PORT", "8320"))
TOKEN = os.environ.get("GAUTH_TOKEN", "").strip()
MAX_BODY = 32 * 1024
# 浏览器流程单飞：第二个请求直接回 busy，由模块按退避重试。
FLOW_LOCK = threading.Lock()
STATE = {"last_error": None, "last_ok_at": None}

FIELDS = ("googleEmail", "googlePassword", "totpSecret")


def normalize_account(body):
    """校验并补齐一个账号请求；label 缺省用邮箱前缀。"""
    if not isinstance(body, dict):
        raise ValueError("请求体必须是 JSON 对象")
    missing = [name for name in FIELDS if not str(body.get(name) or "").strip()]
    if missing:
        raise ValueError("缺少字段: " + ", ".join(missing))
    email = str(body["googleEmail"]).strip()
    label = str(body.get("label") or email.split("@", 1)[0]).strip()[:60] or "account"
    return {
        "label": label,
        "googleEmail": email,
        "googlePassword": str(body["googlePassword"]),
        "totpSecret": str(body["totpSecret"]).strip().replace(" ", ""),
        "firstName": str(body.get("firstName") or "") or None,
        "lastName": str(body.get("lastName") or "") or None,
        "company": str(body.get("company") or "") or None,
    }


def login(account):
    """跑一个账号的全程 OAuth，映射成模块约定的三种失败原因。"""
    with sync_playwright() as p:
        _, out = gauth.run_account(p, account, dry=False)
    if not out or not out.get("sessionId") or not out.get("clientCookie"):
        raise gauth.GAuthError("transient", "收割结果不完整")
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "logicc-gauth/1"

    def log_message(self, fmt, *args):
        print("[http] " + fmt % args, flush=True)

    def _json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self):
        return not TOKEN or self.headers.get("authorization") == "Bearer " + TOKEN

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "busy": FLOW_LOCK.locked()})
        return self._json(404, {"ok": False, "reason": "transient", "message": "not found"})

    def do_POST(self):
        if self.path != "/v1/login":
            return self._json(404, {"ok": False, "reason": "transient", "message": "not found"})
        if not self._authorized():
            return self._json(401, {"ok": False, "reason": "transient", "message": "unauthorized"})
        try:
            length = int(self.headers.get("content-length") or 0)
            if length <= 0 or length > MAX_BODY:
                return self._json(400, {"ok": False, "reason": "transient", "message": "请求体为空或过大"})
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            account = normalize_account(body)
        except Exception as error:
            return self._json(400, {"ok": False, "reason": "transient", "message": f"请求不合法: {error}"})
        if not FLOW_LOCK.acquire(blocking=False):
            return self._json(409, {"ok": False, "reason": "busy", "message": "内核正忙（浏览器流程单飞），请稍后重试"})
        try:
            out = login(account)
            STATE["last_error"] = None
            STATE["last_ok_at"] = True
            return self._json(200, {"ok": True, **out})
        except gauth.GAuthError as error:
            STATE["last_error"] = error.reason
            return self._json(200, {"ok": False, "reason": error.reason, "message": str(error)})
        except Exception as error:  # 未预期异常按 transient 处理，绝不吞掉
            STATE["last_error"] = "transient"
            print(f"[kernel] 未预期异常: {error!r}", flush=True)
            return self._json(200, {"ok": False, "reason": "transient", "message": f"内核异常: {error}"})
        finally:
            FLOW_LOCK.release()


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[kernel] logicc-gauth 小内核监听 :{PORT}（launch={gauth.LAUNCH}, token={'on' if TOKEN else 'off'}）", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
