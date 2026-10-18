// 站点挂在 base（/nana-storage/）下，站内链接一律经过这里。
const BASE = import.meta.env.BASE_URL.replace(/\/?$/, "/");
export const href = (path = "") => BASE + path.replace(/^\//, "");
export const REPO = "https://github.com/darmau/nana-storage";
