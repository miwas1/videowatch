FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY services/api/pyproject.toml /app/pyproject.toml
RUN pip install --no-cache-dir .

COPY services/api/src /app/src
ENV PYTHONPATH=/app/src

EXPOSE 8000
CMD ["uvicorn", "describeops_api.main:app", "--host", "0.0.0.0", "--port", "8000"]
