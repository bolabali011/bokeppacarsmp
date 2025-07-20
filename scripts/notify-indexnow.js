import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { index, url } from '../src/utils/site.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const YOUR_DOMAIN = url;
const API_KEY_NAME = index;
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/IndexNow';

const GOOGLE_SHEETS_TSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS01damVS1XcqEi194soiTdvDxgb3geQW1FsvnlSDAJN2KbtTyVsvw_HK6U9SHwEPUsl2S6O3ajFdb0/pub?gid=0&single=true&output=tsv';

if (!YOUR_DOMAIN) {
  console.error("Error: PUBLIC_SITE_URL is not defined for IndexNow");
  process.exit(1);
}

if (!API_KEY_NAME) {
  console.error("Error: IndexNow API Key is not defined");
  process.exit(1);
}

const LAST_SENT_URLS_CACHE = path.resolve(__dirname, '../.indexnow_cache.json');

async function getAllVideoUrls() {
  try {
    // Fetch data from Google Sheets TSV
    const response = await fetch(GOOGLE_SHEETS_TSV_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch Google Sheet data: ${response.status} - ${response.statusText}`);
    }
    const tsvContent = await response.text();

    // Parse TSV data
    const rows = tsvContent.split('\n').filter(row => row.trim() !== ''); // Split by line and remove empty lines
    if (rows.length === 0) {
      console.warn('Google Sheet is empty or contains no data.');
      return [];
    }

    const headers = rows[0].split('\t').map(header => header.trim()); // Assuming first row is headers
    const dataRows = rows.slice(1); // Actual data starts from the second row

    const allVideos = dataRows.map(row => {
      const values = row.split('\t');
      const video = {};
      headers.forEach((header, index) => {
        video[header] = values[index];
      });
      return video;
    });

    // Validate that 'title' and 'id' exist in the parsed data
    const validVideos = allVideos.filter(video => video.title && video.id);
    if (validVideos.length !== allVideos.length) {
      console.warn('Some rows in Google Sheet are missing "title" or "id" and will be skipped.');
    }

    return validVideos.map(video => {
      const slug = slugify(video.title || 'untitled-video');
      return `${YOUR_DOMAIN}/${slug}-${video.id}/`;
    });
  } catch (error) {
    console.error('Failed to load or process Google Sheet data:', error);
    return [];
  }
}

async function sendToIndexNow(urlsToSend, keyName) {
  if (urlsToSend.length === 0) {
    console.log('No new or updated URLs to send to IndexNow.');
    return;
  }

  const API_KEY_LOCATION = `${YOUR_DOMAIN}/${keyName}.txt`;
  const chunkSize = 10000;

  for (let i = 0; i < urlsToSend.length; i += chunkSize) {
    const chunk = urlsToSend.slice(i, i + chunkSize);

    const payload = {
      host: new URL(YOUR_DOMAIN).hostname,
      key: keyName,
      keyLocation: API_KEY_LOCATION,
      urlList: chunk,
    };

    try {
      console.log(`Sending ${chunk.length} URLs to IndexNow (chunk ${Math.floor(i / chunkSize) + 1})...`);
      const response = await fetch(INDEXNOW_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        console.log(`Successfully sent URL chunk to IndexNow. Status: ${response.status}`);
      } else {
        console.error(`Failed to send URL chunk to IndexNow: ${response.status} - ${response.statusText}`);
        const errorBody = await response.text();
        console.error('Response body:', errorBody);
      }
    } catch (error) {
      console.error('An error occurred while sending to IndexNow:', error);
    }
  }
}

async function main() {
  if (!API_KEY_NAME || typeof API_KEY_NAME !== 'string' || API_KEY_NAME.length !== 36) {
    console.error("Error: IndexNow API Key is invalid or missing.");
    process.exit(1);
  }

  console.log(`Using IndexNow key from site.js: ${API_KEY_NAME}`);

  const currentUrls = await getAllVideoUrls();
  let lastSentUrls = [];

  try {
    const cacheContent = await fs.readFile(LAST_SENT_URLS_CACHE, 'utf-8');
    lastSentUrls = JSON.parse(cacheContent);
  } catch (error) {
    console.log('IndexNow cache not found or corrupted, will send all new URLs.');
  }

  const urlsToSubmit = currentUrls.filter(url => !lastSentUrls.includes(url));

  await sendToIndexNow(urlsToSubmit, API_KEY_NAME);

  try {
    await fs.writeFile(LAST_SENT_URLS_CACHE, JSON.stringify(currentUrls), 'utf-8');
    console.log('IndexNow cache successfully updated.');
  } catch (error) {
    console.error('Failed to update IndexNow cache:', error);
  }
}

main();
