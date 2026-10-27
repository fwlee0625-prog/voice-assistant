"""供本地项目管理平台使用的启动入口。"""
import argparse
import uvicorn

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8015)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()
    uvicorn.run("service.app:app", host=args.host, port=args.port, reload=args.reload)
