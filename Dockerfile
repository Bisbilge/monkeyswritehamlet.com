# Tek imaj: backend + frontend (StaticFiles ile aynı origin'den servis edilir)
FROM python:3.12-slim

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
COPY frontend/ /frontend

ENV FRONTEND_DIR=/frontend \
    DATABASE_URL=sqlite:////data/monkey.db \
    COOKIE_SECURE=true

# SQLite dosyası burada yaşayacak — docker-compose'da bu dizini
# host'a mount ederek konteyner yeniden başlasa/güncellense bile
# leaderboard'un silinmemesini sağlıyoruz.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8000
# --proxy-headers + --forwarded-allow-ips="*": nginx'in gerçek istemci IP'sini
# X-Forwarded-For ile ilettiğini varsayıp request.client.host'u ona göre
# çözer. Güvenli, çünkü bu port sadece host'un 127.0.0.1'ine bağlanıyor
# (docker-compose.yml'e bakın) — dışarıdan hiç kimse bu porta doğrudan
# bağlanıp sahte X-Forwarded-For gönderemez, tek giriş kapısı nginx'tir.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
