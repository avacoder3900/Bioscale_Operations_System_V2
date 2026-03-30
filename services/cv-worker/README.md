# BIMS CV Worker

FastAPI microservice for PaDiM anomaly detection training and ONNX inference.

## Run locally

```bash
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

## Run with Docker

```bash
docker build -t bims-cv-worker .
docker run -p 8000:8000 \
  -e R2_ACCOUNT_ID=... \
  -e R2_ACCESS_KEY_ID=... \
  -e R2_SECRET_ACCESS_KEY=... \
  -e R2_BUCKET_NAME=brevitest-cv \
  bims-cv-worker
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |
| POST | /train | Start PaDiM training for a project |
| GET | /status?project_id=X | Poll training progress |
| POST | /infer | Run inference on a single image |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| R2_ACCOUNT_ID | | Cloudflare account ID |
| R2_ACCESS_KEY_ID | | R2 access key |
| R2_SECRET_ACCESS_KEY | | R2 secret key |
| R2_BUCKET_NAME | brevitest-cv | R2 bucket name |
| MODEL_INPUT_SIZE | 256 | Input image size |
| CONFIDENCE_THRESHOLD | 0.5 | Anomaly threshold |
| TRAINING_DATA_DIR | /tmp/cv-training | Local scratch dir |
