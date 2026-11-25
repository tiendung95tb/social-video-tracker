import { describe, expect, test } from 'bun:test';
import {
  buildChannelsCsv,
  buildDoctorsCsv,
  buildMonthlyExportSheetRows,
  extractGoogleSheetInfo,
  extractMonthFromIso,
  getMonthStartDate,
  maskSecret,
  normalizeDateIso,
  parseBulkChannelText,
  parseChannelLine,
  parseGoogleSheetRows,
} from '../src/parser.js';

describe('parser helpers', () => {
  test('parses TikTok and Facebook URLs cleanly', () => {
    const tt = parseChannelLine('[Jane Creator](https://www.tiktok.com/@janecreator?lang=en)');
    expect(tt?.platform).toBe('tiktok');
    expect(tt?.handle).toBe('janecreator');
    expect(tt?.url).toBe('https://www.tiktok.com/@janecreator');

    const fb = parseChannelLine('https://www.facebook.com/profile.php?id=61500000000001');
    expect(fb?.platform).toBe('facebook');
    expect(fb?.handle).toBe('61500000000001');
  });

  test('bulk parser skips invalid lines and deduplicates handles', () => {
    const items = parseBulkChannelText(`
      /
      Pending
      https://www.tiktok.com/@alpha_channel
      https://www.tiktok.com/@alpha_channel?lang=en
      https://www.facebook.com/beta_page/
    `);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.handle)).toEqual(['alpha_channel', 'beta_page']);
  });

  test('extracts spreadsheetId and gid and auto-detects columns in any Google Sheet', () => {
    expect(
      extractGoogleSheetInfo('https://docs.google.com/spreadsheets/d/abc123_XYZ-99/edit?gid=4242#gid=4242'),
    ).toEqual({ spreadsheetId: 'abc123_XYZ-99', gid: '4242' });
    expect(extractGoogleSheetInfo('https://example.com')).toBeNull();

    const parsed = parseGoogleSheetRows([
      ['Creator Name', 'Owner', 'Category', 'TikTok Link', 'Facebook Link', 'Status'],
      ['Alice', 'Team 1', 'Tech', 'https://www.tiktok.com/@alice_tech', 'https://www.facebook.com/alicetech', 'Active'],
      ['Bob', 'Team 2', 'Food', 'https://www.tiktok.com/@bob_food', '', 'Inactive'],
    ]);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].ugOwner).toBe('Team 1');
    expect(parsed[0].enabled).toBe(true);
    expect(parsed[1].platform).toBe('facebook');
    expect(parsed[2].enabled).toBe(false);
  });

  test('normalizes dates, masks secrets, and builds CSV & Google Sheet export rows', () => {
    expect(getMonthStartDate('2026-11')).toBe('2026-11-01');
    expect(normalizeDateIso(1730419200)).toBe('2024-11-01T00:00:00.000Z');
    expect(extractMonthFromIso('2026-11-15T10:20:00.000Z')).toBe('2026-11');
    expect(maskSecret('apify_api_1234567890abcd')).toBe('apify_••••abcd');

    const csv = buildDoctorsCsv('2026-11', [
      {
        doctorGroup: 'Creator, "A"',
        channelsCount: 2,
        platforms: ['tiktok', 'facebook'],
        tiktokVideos: 10,
        tiktokViews: 50000,
        facebookVideos: 5,
        facebookViews: 12000,
        totalVideos: 15,
        totalViews: 62000,
        totalLikes: 1200,
        totalComments: 45,
        totalShares: 30,
        avgViews: 4133,
      },
    ]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"Creator, ""A"""');
    expect(buildChannelsCsv('2026-11', []).startsWith('\uFEFF')).toBe(true);

    const rows = buildMonthlyExportSheetRows({
      month: '2026-11',
      sinceDate: '2026-11-01',
      summary: {
        totalChannels: 1,
        enabledChannels: 1,
        tiktokChannels: 1,
        facebookChannels: 0,
        periodVideos: 5,
        periodViews: 50000,
        periodLikes: 900,
        periodComments: 42,
        periodShares: 18,
        tiktokPeriodVideos: 5,
        tiktokPeriodViews: 50000,
        facebookPeriodVideos: 0,
        facebookPeriodViews: 0,
        avgViewsPerVideo: 10000,
        monthSpendUsd: 0.25,
      },
      channels: [],
      doctors: [],
    });
    expect(rows[0][0]).toContain('2026-11');
    expect(rows[2]).toContain('Likes: 900');
    expect(rows[2]).toContain('Comments: 42');
  });
});
