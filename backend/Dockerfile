FROM python:3.12-slim
WORKDIR /srv
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
# Inside a container the API listens on all interfaces; app/main.py refuses that without APP_PASSWORD.
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
RUN useradd -m app && mkdir -p /data && chown app /data
USER app
EXPOSE 3000
CMD ["python", "-m", "app.server"]
