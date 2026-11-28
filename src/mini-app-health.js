// Only minute buckets are retained. No account, URL, IP or device identifier.
export function createMiniAppHealth() {
  const minutes = new Map();
  function prune(minute) {
    for (const key of minutes.keys()) if (key < minute - 10) minutes.delete(key);
  }
  return {
    observe(stage, now = Date.now()) {
      const minute = Math.floor(now / 60000);
      prune(minute);
      const bucket = minutes.get(minute) || { opened: 0, rendered: 0 };
      bucket[stage]++;
      minutes.set(minute, bucket);
    },
    stalled(now = Date.now()) {
      const minute = Math.floor(now / 60000);
      prune(minute);
      let attempts = 0;
      for (const [key, bucket] of minutes) {
        if (bucket.rendered) attempts = 0;
        else if (key <= minute - 2) attempts += bucket.opened;
      }
      return attempts >= 2;
    }
  };
}

export function isIphoneWebView(request) {
  const ua = request.headers['user-agent'] || '';
  return request.method === 'GET' && /iPhone/.test(ua) && /AppleWebKit/.test(ua) && !/Safari\//.test(ua);
}
