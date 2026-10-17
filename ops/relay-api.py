# -*- coding: utf-8 -*-
"""TLS 中继：把本地 /api/* 转发到 app.logicc.com/api/*。

背景：app.logicc.com 的 CF 按 TLS 指纹拦 Node（undici / fetch）的请求，
补齐浏览器请求头也过不了；同出口 IP 下 python urllib 实测畅通——所以
中继用 urllib 原样转发。进程内强制 getaddrinfo 只回 IPv4（部分宿主机
v6 路由黑洞会让握手吊死）。详见 docs/logicc-module.md。
用法：python3 ops/relay-api.py   （监听 127.0.0.1:18790）
CPAN 侧：.env 设 LOGICC_API_BASE=http://127.0.0.1:18790/api 后重启。
支持流式（SSE）透传：按块读上游、逐块写回。
"""
import http.server
import socket
import urllib.error
import urllib.request

UP_BASE = "https://app.logicc.com"
FWD_HEADERS = ("authorization", "accept", "content-type", "stream-response-protocol")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"

# 进程内强制 IPv4（本机 v6 路由黑洞，握手会吊死）
_gai = socket.getaddrinfo
def _gai_v4(host, port, *args, **kwargs):
    rows = [r for r in _gai(host, port, *args, **kwargs) if r[0] == socket.AF_INET]
    return rows or _gai(host, port, *args, **kwargs)
socket.getaddrinfo = _gai_v4


class Relay(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _relay(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {"User-Agent": UA}
        for k, v in self.headers.items():
            if k.lower() in FWD_HEADERS:
                headers[k] = v
        req = urllib.request.Request(UP_BASE + self.path, data=body,
                                     method=self.command, headers=headers)
        try:
            resp = urllib.request.urlopen(req, timeout=300)
        except urllib.error.HTTPError as e:
            resp = e  # HTTPError 也是可读响应，把状态原样带回
        except Exception as exc:  # noqa: BLE001
            self.send_error(502, f"relay: {str(exc)[:120]}")
            return
        try:
            self.send_response(resp.status if hasattr(resp, "status") else resp.code)
            ct = resp.headers.get("Content-Type")
            if ct:
                self.send_header("Content-Type", ct)
            cl = resp.headers.get("Content-Length")
            if cl:
                self.send_header("Content-Length", cl)
            else:  # SSE 等无长度响应：关连接终结，不实现 chunked
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            while True:
                chunk = resp.read(2048)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except Exception:  # 客户端断开等，安静收尾
            pass
        finally:
            try:
                resp.close()
            except Exception:
                pass

    do_GET = do_POST = do_PATCH = do_DELETE = do_PUT = _relay

    def log_message(self, fmt, *args):  # 安静模式
        pass


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("127.0.0.1", 18790), Relay).serve_forever()
