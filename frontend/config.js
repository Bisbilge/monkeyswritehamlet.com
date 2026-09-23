// Bu dosya, GitHub Actions Pages workflow'u tarafından deploy anında
// otomatik dolduruluyor (bkz. .github/workflows/pages.yml) — aşağıdaki
// placeholder, Cloudflare Worker'ınızın *.workers.dev adresiyle
// değiştiriliyor. Yerelde çalıştırıyorsanız elle bir URL yazabilirsiniz.
window.MONKEY_API_BASE = "__WORKER_URL__";
