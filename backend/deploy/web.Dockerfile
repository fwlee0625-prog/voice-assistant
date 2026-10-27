FROM python:3.11-slim
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/voice/ voice/
COPY backend/service/ service/
COPY web/ web/
COPY backend/run.py .
EXPOSE 8015
CMD ["python", "run.py", "--host", "0.0.0.0", "--port", "8015"]
