import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
// import rawVideosData from '../data/videos.json' with { type: 'json' }; // Baris ini akan dihapus
import { url } from './site.js';

function slugify(text) {
    return text
        .toString()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^\w-]+/g, '')
        .replace(/--+/g, '-');
}

// const videosData = rawVideosData; // Baris ini akan diubah

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.join(__dirname, '../../');
const publicDir = path.join(projectRoot, 'public');

const OPTIMIZED_IMAGES_SUBDIR = 'picture';
const optimizedThumbnailsDir = path.join(publicDir, OPTIMIZED_IMAGES_SUBDIR);

const OUTPUT_TS_PATH = path.resolve(__dirname, '../data/allVideos.ts');

const YOUR_DOMAIN = url;
if (!YOUR_DOMAIN) {
    console.error("Error: PUBLIC_SITE_URL is not defined in environment variables. Please check your .env file and ensure it's loaded.");
    process.exit(1);
}

const DEFAULT_FALLBACK_WIDTH = 300;
const DEFAULT_FALLBACK_HEIGHT = 168;
const OPTIMIZED_THUMBNAIL_WIDTH = 300;

const DOWNLOAD_TIMEOUT_MS = 100000;

async function fetchWithTimeout(resource, options = {}) {
    const { timeout = DOWNLOAD_TIMEOUT_MS } = options;

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(resource, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// Fungsi baru untuk mengambil dan memproses data TSV
async function fetchVideosDataFromGoogleSheet() {
    const tsvUrl = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS01damVS1XcqEi194soiTdvDxgb3geQW1FsvnlSDAJN2KbtTyVsvw_HK6U9SHwEPUsl2S6O3ajFdb0/pub?gid=0&single=true&output=tsv';
    
    try {
        const response = await fetchWithTimeout(tsvUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch TSV data: ${response.statusText}`);
        }
        const tsvText = await response.text();
        
        // Memparsing TSV
        const lines = tsvText.split('\n').filter(line => line.trim() !== ''); // Filter baris kosong
        const headers = lines[0].split('\t').map(header => header.trim());
        
        const videos = lines.slice(1).map(line => {
            const values = line.split('\t').map(value => value.trim());
            const video = {};
            headers.forEach((header, index) => {
                // Konversi string "TRUE" / "FALSE" menjadi boolean
                if (values[index] === "TRUE") {
                    video[header] = true;
                } else if (values[index] === "FALSE") {
                    video[header] = false;
                } else {
                    video[header] = values[index];
                }
            });
            // Pastikan properti 'id' ada dan unik. Jika tidak ada, gunakan slugify dari judul sebagai fallback.
            if (!video.id) {
                video.id = slugify(video.title || `video-${Date.now()}`); // Fallback jika ID tidak ada
            }
            return video;
        });

        console.log(`Successfully fetched ${videos.length} videos from Google Sheet.`);
        return videos;

    } catch (error) {
        console.error("Error fetching or parsing Google Sheet data:", error);
        return []; // Mengembalikan array kosong jika ada kesalahan
    }
}


async function processThumbnails() {
    await fs.mkdir(optimizedThumbnailsDir, { recursive: true });
    const outputTsDir = path.dirname(OUTPUT_TS_PATH);
    await fs.mkdir(outputTsDir, { recursive: true });

    // Panggil fungsi untuk mendapatkan data dari Google Sheet
    const videosData = await fetchVideosDataFromGoogleSheet();

    const processingPromises = videosData.map(async (video) => {
        const videoSlug = slugify(video.title || 'untitled-video');
        const thumbnailFileName = `${videoSlug}-${video.id}.webp`;
        const outputPath = path.join(optimizedThumbnailsDir, thumbnailFileName);
        const relativeThumbnailPath = `${YOUR_DOMAIN}/${OPTIMIZED_IMAGES_SUBDIR}/${thumbnailFileName}`;

        let finalThumbnailUrl = null;
        let finalWidth = DEFAULT_FALLBACK_WIDTH;
        let finalHeight = DEFAULT_FALLBACK_HEIGHT;

        if (!video.thumbnail) {
            return {
                ...video,
                thumbnail: null,
                thumbnailWidth: DEFAULT_FALLBACK_WIDTH,
                thumbnailHeight: DEFAULT_FALLBACK_HEIGHT,
            };
        }

        let thumbnailOptimizedSuccessfully = false;

        const attemptOptimizeAndSave = async (urlOrPath, isRemote) => {
            let buffer = null;
            if (isRemote) {
                const response = await fetchWithTimeout(urlOrPath);
                if (!response.ok) {
                    throw new Error(`Failed to download: ${response.statusText}`);
                }
                buffer = Buffer.from(await response.arrayBuffer());
            } else {
                const localFilePath = path.join(publicDir, urlOrPath);
                try {
                    await fs.access(localFilePath);
                    buffer = await fs.readFile(localFilePath);
                } catch (err) {
                    console.error(`[ERROR] Local file not found at ${localFilePath}. Skipping optimization for this path.`);
                    throw err; // Lempar error agar percobaan berikutnya bisa dilakukan
                }
            }

            const optimizedBuffer = await sharp(buffer)
                .resize({ width: OPTIMIZED_THUMBNAIL_WIDTH, withoutEnlargement: true })
                .webp({ quality: 70 })
                .toBuffer();

            const optimizedMetadata = await sharp(optimizedBuffer).metadata();
            finalWidth = optimizedMetadata.width || DEFAULT_FALLBACK_WIDTH;
            finalHeight = optimizedMetadata.height || DEFAULT_FALLBACK_HEIGHT;

            await fs.writeFile(outputPath, optimizedBuffer);
            finalThumbnailUrl = relativeThumbnailPath;
            return true;
        };

        // --- Attempt 1: Try original thumbnail URL/path for optimization ---
        try {
            thumbnailOptimizedSuccessfully = await attemptOptimizeAndSave(
                video.thumbnail,
                video.thumbnail.startsWith('http')
            );
        } catch (error) {
            // console.warn(`[WARN] Attempt 1 failed for video ${video.id} (${video.title}): ${error.message}`);
        }

        // --- Attempt 2: If original failed and it's a Doodcdn URL, try the opposite type ---
        if (!thumbnailOptimizedSuccessfully && video.thumbnail.includes('postercdn.com')) {
            let altDoodcdnUrl = null;

            if (video.thumbnail.includes('/snaps/')) {
                altDoodcdnUrl = video.thumbnail.replace('/snaps/', '/snaps/');
            } else if (video.thumbnail.includes('/snaps/')) {
                altDoodcdnUrl = video.thumbnail.replace('/snaps/', '/splash/');
            }
            
            if (altDoodcdnUrl) {
                try {
                    thumbnailOptimizedSuccessfully = await attemptOptimizeAndSave(altDoodcdnUrl, true);
                } catch (error) {
                    console.error(`[ERROR] thumbnail gagal untuk ${video.id} (${video.title}).`);
                }
            }
        }
        
        // --- Final Fallback: Use original URL/path directly if all optimization attempts failed ---
        if (!thumbnailOptimizedSuccessfully) {
            if (video.thumbnail.startsWith('http')) {
                finalThumbnailUrl = video.thumbnail;
            } else {
                const localInputPath = path.join(publicDir, video.thumbnail);
                try {
                    await fs.access(localInputPath);
                    finalThumbnailUrl = video.thumbnail;
                } catch (err) {
                    console.error(`[ERROR] All thumbnail attempts failed for video ${video.id} (${video.title}). Original local file not found at ${localInputPath}. Thumbnail will be null.`);
                    finalThumbnailUrl = null;
                }
            }
        }

        return {
            ...video,
            thumbnail: finalThumbnailUrl,
            thumbnailWidth: finalWidth,
            thumbnailHeight: finalHeight,
        };
    });

    const processedVideos = await Promise.all(processingPromises);

    const outputContent = `import type { VideoData } from '../utils/data';\n\nconst allVideos: VideoData[] = ${JSON.stringify(processedVideos, null, 2)};\n\nexport default allVideos;\n`;
    await fs.writeFile(OUTPUT_TS_PATH, outputContent, 'utf-8');
}

processThumbnails().catch(console.error);