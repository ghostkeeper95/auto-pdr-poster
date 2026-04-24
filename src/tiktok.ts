const TIKWM_API = "https://www.tikwm.com/api/";

interface TikWmResponse {
  code: number;
  msg: string;
  data?: {
    play: string;
    wmplay: string;
    title: string;
    duration: number;
  };
}

export interface TikTokInfo {
  videoUrl: string;
  downloadUrl: string;
  fallbackUrl?: string;
  title: string;
}

export function isTikTokUrl(text: string): boolean {
  return /https?:\/\/(vt\.|vm\.|www\.)?tiktok\.com\S*/i.test(text);
}

export async function fetchTikTokInfo(url: string): Promise<TikTokInfo> {
  const params = new URLSearchParams({ url, hd: "1" });
  const res = await fetch(`${TIKWM_API}?${params}`);

  if (!res.ok) {
    throw new Error(`Помилка tikwm API: ${res.status}`);
  }

  const data = (await res.json()) as TikWmResponse;

  if (data.code !== 0 || !data.data?.play) {
    throw new Error(data.msg || "Не вдалося отримати відео без вотермарки");
  }

  return {
    videoUrl: url,
    downloadUrl: data.data.play,
    fallbackUrl: data.data.wmplay || undefined,
    title: data.data.title ?? "",
  };
}
