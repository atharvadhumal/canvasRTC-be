export function getClientUrl(): string {
  const direct = process.env.CLIENT_URL?.trim();
  if (direct) return direct.replace(/\/$/, '');

  const urls = (process.env.CLIENT_URLS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (process.env.NODE_ENV === 'production') {
    const httpsUrl = urls.find((url) => url.startsWith('https://'));
    if (httpsUrl) return httpsUrl.replace(/\/$/, '');
  }

  const first = urls[0];
  if (first) return first.replace(/\/$/, '');

  return 'http://localhost:5173';
}
