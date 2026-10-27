from .config import Settings


def main():
    import uvicorn

    settings = Settings.from_env()
    uvicorn.run(
        "model_service.app:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        workers=1,
    )


if __name__ == "__main__":
    main()
