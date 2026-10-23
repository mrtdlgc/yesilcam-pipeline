import youtubedl from 'youtube-dl-exec';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

export async function checkExistingSubtitles(youtubeUrl, imdbId) {
  console.log('Checking for existing subtitles...');

  // 1. Check YouTube for subtitles (user-uploaded only, non-auto-generated)
  try {
    const ytSubs = await checkYouTubeSubtitles(youtubeUrl);
    if (ytSubs) {
      const langLabel = ytSubs.language === 'tr' ? 'Turkish' : 'English';
      console.log(`✓ Found ${langLabel} subtitles on YouTube`);
      return ytSubs;
    }
  } catch (error) {
    console.log('YouTube subtitle check failed:', error.message);
  }

  // 2. Check OpenSubtitles ONLY if IMDB ID is provided
  if (imdbId && imdbId.trim() !== '') {
    if (!process.env.OPENSUBTITLES_API_KEY) {
      console.log('⚠ IMDB ID provided but OpenSubtitles API key not configured');
    } else {
      try {
        const openSubs = await checkOpenSubtitles(imdbId);
        if (openSubs) {
          const langLabel = openSubs.language === 'tr' ? 'Turkish' : 'English';
          console.log(`✓ Found ${langLabel} subtitles on OpenSubtitles`);
          return openSubs;
        }
      } catch (error) {
        console.log('OpenSubtitles check failed:', error.message);
      }
    }
  } else {
    console.log('ℹ No IMDB ID provided, skipping OpenSubtitles check');
  }

  console.log('✗ No existing subtitles found. Will generate new ones.');
  return null;
}

async function checkYouTubeSubtitles(youtubeUrl) {
  try {
    // Get video info including subtitle tracks
    const info = await youtubedl(youtubeUrl, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      skipDownload: true
    });

    const subtitles = info.subtitles || {};

    // Check for Turkish subtitles first (user-uploaded, skip auto-generated)
    // Turkish subtitles are the source material for manual English translation
    if (subtitles.tr && subtitles.tr.length > 0) {
      console.log('Found Turkish subtitle track');
      const subUrl = subtitles.tr[0].url;
      const content = await downloadSubtitle(subUrl);

      // Detect actual language by checking content
      const actualLanguage = detectSubtitleLanguage(content);
      console.log(`Detected language: ${actualLanguage}`);

      return {
        source: 'youtube',
        content: content,
        isAuto: false,
        language: actualLanguage
      };
    }

    // Check for English subtitles as fallback
    // If English subtitles exist, we can use them directly (no translation needed)
    if (subtitles.en && subtitles.en.length > 0) {
      console.log('Found English subtitle track');
      const subUrl = subtitles.en[0].url;
      const content = await downloadSubtitle(subUrl);

      return {
        source: 'youtube',
        content: content,
        isAuto: false,
        language: 'en'
      };
    }

    // Skip automatic captions - we only want user-uploaded subtitles
    return null;
  } catch (error) {
    console.error('YouTube subtitle check error:', error);
    return null;
  }
}

async function checkOpenSubtitles(imdbId) {
  if (!process.env.OPENSUBTITLES_API_KEY) {
    console.log('OpenSubtitles API key not configured');
    return null;
  }

  try {
    // Clean IMDB ID (remove 'tt' prefix if present)
    const cleanImdbId = imdbId.replace(/^tt/, '');

    // Check for Turkish subtitles first
    let response = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
      headers: {
        'Api-Key': process.env.OPENSUBTITLES_API_KEY,
        'Content-Type': 'application/json'
      },
      params: {
        imdb_id: cleanImdbId,
        languages: 'tr',
        type: 'movie'
      }
    });

    if (response.data.data && response.data.data.length > 0) {
      const subtitle = response.data.data[0];

      // Download subtitle
      const downloadResponse = await axios.get(
        `https://api.opensubtitles.com/api/v1/download`,
        {
          headers: {
            'Api-Key': process.env.OPENSUBTITLES_API_KEY
          },
          params: {
            file_id: subtitle.attributes.files[0].file_id
          }
        }
      );

      const downloadUrl = downloadResponse.data.link;
      const content = await downloadSubtitle(downloadUrl);

      return {
        source: 'opensubtitles',
        content: content,
        isAuto: false,
        language: 'tr'
      };
    }

    // Check for English subtitles as fallback
    response = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
      headers: {
        'Api-Key': process.env.OPENSUBTITLES_API_KEY,
        'Content-Type': 'application/json'
      },
      params: {
        imdb_id: cleanImdbId,
        languages: 'en',
        type: 'movie'
      }
    });

    if (response.data.data && response.data.data.length > 0) {
      const subtitle = response.data.data[0];

      // Download subtitle
      const downloadResponse = await axios.get(
        `https://api.opensubtitles.com/api/v1/download`,
        {
          headers: {
            'Api-Key': process.env.OPENSUBTITLES_API_KEY
          },
          params: {
            file_id: subtitle.attributes.files[0].file_id
          }
        }
      );

      const downloadUrl = downloadResponse.data.link;
      const content = await downloadSubtitle(downloadUrl);

      return {
        source: 'opensubtitles',
        content: content,
        isAuto: false,
        language: 'en'
      };
    }

    return null;
  } catch (error) {
    console.error('OpenSubtitles API error:', error.message);
    return null;
  }
}

// Convert JSON3 subtitle format to SRT
function json3ToSrt(json3Data) {
  if (!json3Data.events || !Array.isArray(json3Data.events)) {
    throw new Error('Invalid JSON3 subtitle format');
  }

  let srtContent = '';
  let counter = 1;

  for (const event of json3Data.events) {
    if (!event.segs || event.segs.length === 0) continue;

    const startMs = event.tStartMs || 0;
    const durationMs = event.dDurationMs || 0;
    const endMs = startMs + durationMs;

    // Convert milliseconds to SRT timestamp format (HH:MM:SS,mmm)
    const startTime = msToSrtTime(startMs);
    const endTime = msToSrtTime(endMs);

    // Get subtitle text
    const text = event.segs.map(seg => seg.utf8).join('');

    // Write SRT entry
    srtContent += `${counter}\n`;
    srtContent += `${startTime} --> ${endTime}\n`;
    srtContent += `${text}\n\n`;

    counter++;
  }

  return srtContent.trim();
}

// Convert milliseconds to SRT timestamp format
function msToSrtTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = ms % 1000;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

// Simple language detection based on character patterns
function detectSubtitleLanguage(srtContent) {
  // Take a sample of the subtitle text (first 1000 chars)
  const sample = srtContent.substring(0, 1000).toLowerCase();

  // Turkish-specific characters and patterns
  const turkishChars = /[çğıöşü]/;
  const turkishWords = /(bir|bu|için|var|mi|da|de|ile|gibi|daha|şey)/;

  // English-specific patterns
  const englishWords = /(the|is|are|and|to|of|in|that|have|this|for|with|you|was|be|on|at)/;

  // Count occurrences
  const turkishCharCount = (sample.match(turkishChars) || []).length;
  const turkishWordMatches = (sample.match(turkishWords) || []).length;
  const englishWordMatches = (sample.match(englishWords) || []).length;

  // If we have Turkish-specific characters, it's likely Turkish
  if (turkishCharCount > 3) {
    return 'tr';
  }

  // If English words heavily outweigh Turkish words, it's English
  if (englishWordMatches > turkishWordMatches * 2) {
    return 'en';
  }

  // If Turkish words are dominant, it's Turkish
  if (turkishWordMatches > englishWordMatches) {
    return 'tr';
  }

  // Default to English if unclear
  return 'en';
}

async function downloadSubtitle(url) {
  const response = await axios.get(url);

  // Check if it's a JSON3 format (YouTube's format)
  if (typeof response.data === 'object' && response.data.events) {
    return json3ToSrt(response.data);
  }

  // If it's already a string (SRT format), return it
  if (typeof response.data === 'string') {
    return response.data;
  }

  // Fallback for other formats
  throw new Error('Unsupported subtitle format');
}
