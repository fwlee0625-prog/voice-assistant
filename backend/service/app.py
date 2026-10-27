import os
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[1]
# 本地 web/ 与 backend/ 同级；镜像内两者都复制进 /app
WEB_DIR = ROOT.parent / "web"
if not WEB_DIR.is_dir():
    WEB_DIR = ROOT / "web"
load_dotenv(ROOT / ".env")
from service.routes import register_routes

app = FastAPI(title="Billiards Voice", version="0.1.0")
register_routes(app)

@app.get("/api/health")
def health():
    return {"status": "ok", "service": "billiards_voice"}

@app.get("/")
def index():
    return FileResponse(WEB_DIR / "voice.html")

@app.get("/table")
def table():
    url = os.environ.get("BILLIARDS_CORE_URL", "").rstrip("/")
    if not url:
        return JSONResponse({"error": "请先在 .env 配置 BILLIARDS_CORE_URL"}, status_code=503)
    return RedirectResponse(url + "/index.html")

app.mount("/", StaticFiles(directory=WEB_DIR), name="web")
