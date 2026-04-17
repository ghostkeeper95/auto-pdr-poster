const PEXELS_API = "https://api.pexels.com/v1";

interface PexelsPhoto {
  src: {
    original: string;
    large2x: string;
    large: string;
    landscape: string;
  };
}

interface PexelsSearchResponse {
  photos: PexelsPhoto[];
}

export async function searchStockImage(apiKey: string, query: string): Promise<string | undefined> {
  const url = `${PEXELS_API}/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape&size=large`;

  const res = await fetch(url, {
    headers: { Authorization: apiKey },
  });

  if (!res.ok) {
    console.warn(`Pexels API error: ${res.status}`);
    return undefined;
  }

  const data = (await res.json()) as PexelsSearchResponse;
  return data.photos[0]?.src.landscape;
}
