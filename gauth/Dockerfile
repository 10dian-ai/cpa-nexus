FROM python:3.12-slim

# logicc-gauth 模块小内核：gauth.py 全功能保留，外加一个 stdlib HTTP 封装。
# 镜像只服务 compose 内网（无对外端口）；浏览器流程单飞。
ENV PYTHONUNBUFFERED=1 \
    GAUTH_LAUNCH=1 \
    GAUTH_PORT=8320
WORKDIR /app

RUN pip install --no-cache-dir "patchright>=1.49,<2" "pyotp>=2.9,<3" \
    && patchright install --with-deps chromium \
    && pip cache purge

COPY gauth.py server.py README.md CPAN.md ./

EXPOSE 8320
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8320/health',timeout=3).status==200 else 1)"

CMD ["python", "server.py"]
