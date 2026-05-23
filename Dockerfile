FROM node:22-slim AS frontend
WORKDIR /fe

COPY package.json ./
COPY tools/frontend-manifest.mjs tools/build_frontend.mjs ./tools/
COPY static/js ./static/js

RUN npm install --silent && npm run build

FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=5000 \
    FLASK_DEBUG=0 \
    USE_JS_BUNDLE=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY scripts ./scripts
COPY tools ./tools
COPY static ./static
COPY --from=frontend /fe/static/dist ./static/dist

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/')"

CMD ["python", "scripts/launch.py", "--host", "0.0.0.0", "--no-browser"]
