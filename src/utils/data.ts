// src/utils/data.ts
import rawAllVideos from '../data/allVideos';

// Definisi interface untuk setiap objek video
export interface VideoData {
  id: string;
  title: string;
  description: string;
  category: string;
  thumbnail: string;
  thumbnailWidth: number;
  thumbnailHeight: number;
  datePublished?: string;
  dateModified?: string;
  embedUrl: string;
  tags: string;
  previewUrl?: string;
  duration?: string;

}

export async function getAllVideos(): Promise<VideoData[]> {
  console.log(`[getAllVideos] Data dari allVideos.ts dimuat. Total video: ${rawAllVideos.length}`);
  return rawAllVideos as VideoData[];
}
