import { describe, expect, test } from 'bun:test';
import {
  buildFacebookActorInput,
  buildTiktokActorInput,
  estimateCostUsd,
  extractTiktokError,
  matchItemToChannel,
  normalizeFacebookItem,
  normalizeTiktokItem,
} from '../src/apify.js';
import type { Channel } from '../src/types.js';

const sampleChannels: Channel[] = [
  {
    id: 1,
    platform: 'tiktok',
    handle: 'demo_creator',
    url: 'https://www.tiktok.com/@demo_creator',
    displayName: 'Demo Creator',
    doctorGroup: 'Demo Creator',
    ugOwner: 'Team A',
    specialty: 'Education',
    cooperationStatus: 'Active',
    sheetRow: 2,
    enabled: true,
    profileVideoCount: null,
    profileFollowers: null,
    lastScannedAt: null,
    lastError: null,
    createdAt: '2026-11-01T00:00:00Z',
  },
  {
    id: 2,
    platform: 'facebook',
    handle: '61500000000001',
    url: 'https://www.facebook.com/profile.php?id=61500000000001',
    displayName: 'Demo Creator (FB)',
    doctorGroup: 'Demo Creator',
    ugOwner: 'Team A',
    specialty: 'Education',
    cooperationStatus: 'Active',
    sheetRow: 2,
    enabled: true,
    profileVideoCount: null,
    profileFollowers: null,
    lastScannedAt: null,
    lastError: null,
    createdAt: '2026-11-01T00:00:00Z',
  },
];

describe('apify client helpers', () => {
  test('builds batched TikTok input with oldestPostDateUnified from start of month', () => {
    const input = buildTiktokActorInput([sampleChannels[0]], '2026-11-01', 18);
    expect(input.profiles).toEqual(['demo_creator']);
    expect(input.oldestPostDateUnified).toBe('2026-11-01');
    expect(input.resultsPerPage).toBe(18);
    expect(input.shouldDownloadVideos).toBe(false);
  });

  test('builds batched Facebook input with startUrls and limits', () => {
    const input = buildFacebookActorInput([sampleChannels[1]], 20);
    expect(input.startUrls).toEqual([{ url: 'https://www.facebook.com/profile.php?id=61500000000001' }]);
    expect(input.resultsLimit).toBe(20);
  });

  test('normalizes Clockworks TikTok output and matches channel', () => {
    const item = normalizeTiktokItem({
      id: '7432100000123456',
      text: 'Demo video caption',
      createTimeISO: '2026-11-10T08:30:00.000Z',
      webVideoUrl: 'https://www.tiktok.com/@demo_creator/video/7432100000123456',
      playCount: 45200,
      diggCount: 1200,
      commentCount: 84,
      shareCount: 210,
      authorMeta: { name: 'demo_creator', video: 142, fans: 89000 },
      videoMeta: { duration: 64 },
    });
    expect(item).not.toBeNull();
    expect(item?.views).toBe(45200);
    expect(item?.publishedMonth).toBe('2026-11');
    expect(item?.profileVideoCount).toBe(142);
    expect(matchItemToChannel(item!, sampleChannels)?.id).toBe(1);
  });

  test('normalizes Facebook reels fields including playCountRounded and sharesCountRounded', () => {
    const item = normalizeFacebookItem({
      facebookUrl: 'https://www.facebook.com/profile.php?id=61500000000001',
      inputUrl: 'https://www.facebook.com/profile.php?id=61500000000001',
      topLevelReelUrl: 'https://www.facebook.com/reel/2460921817728812',
      text: 'Demo FB reel',
      time: '2026-11-15T10:54:23.000Z',
      playCountRounded: 2690,
      play_count: null,
      reelId: '2460921817728812',
      likesCount: 45,
      commentsCount: 8,
      sharesCountRounded: 12,
      durationSeconds: 38,
    });
    expect(item).not.toBeNull();
    expect(item?.views).toBe(2690);
    expect(item?.shares).toBe(12);
    expect(item?.durationSec).toBe(38);
    expect(matchItemToChannel(item!, sampleChannels)?.id).toBe(2);
  });

  test('filters out Clockworks TikTok error rows and extracts error metadata', () => {
    const rawErr = {
      error: 'This profile/hashtag does not exist.',
      errorCode: 'NOT_FOUND',
      url: 'https://www.tiktok.com/@demo_creator',
      input: 'demo_creator',
    };
    expect(normalizeTiktokItem(rawErr)).toBeNull();
    const errInfo = extractTiktokError(rawErr);
    expect(errInfo?.errorCode).toBe('NOT_FOUND');
    expect(errInfo?.channelMatchKeys).toContain('demo_creator');
  });

  test('estimates Free-tier cost conservatively', () => {
    const est = estimateCostUsd(30, 10, 18, 20);
    expect(est.estimatedUsd).toBeLessThan(2.5);
  });
});
