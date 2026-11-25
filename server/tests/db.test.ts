import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TrackerDb } from '../src/db.js';

function createTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-tracker-public-test-'));
  const db = new TrackerDb(dir);
  return {
    db,
    cleanup: () => {
      db.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('TrackerDb (Public clean start)', () => {
  test('starts cleanly with zero hardcoded channels and empty sheet URLs', () => {
    const { db, cleanup } = createTempDb();
    try {
      const dash = db.getDashboard({ month: '2026-11' });
      expect(dash.summary.totalChannels).toBe(0);
      expect(dash.settings.googleSheetUrl).toBe('');
      expect(dash.settings.exportSheetUrl).toBe('');
      expect(dash.settings.monthlyBudgetUsd).toBe(5);
    } finally {
      cleanup();
    }
  });

  test('aggregates monthly videos, views, likes, comments and groups TikTok + FB creators', () => {
    const { db, cleanup } = createTempDb();
    try {
      const tt = db.upsertChannel({
        platform: 'tiktok',
        handle: 'demo_creator',
        url: 'https://www.tiktok.com/@demo_creator',
        displayName: 'Demo Creator',
        doctorGroup: 'Demo Creator',
      });
      const fb = db.upsertChannel({
        platform: 'facebook',
        handle: 'democreator',
        url: 'https://www.facebook.com/democreator',
        displayName: 'Demo Creator (FB)',
        doctorGroup: 'Demo Creator',
      });

      db.upsertVideos([
        {
          id: 'tiktok:1',
          channelId: tt.id,
          platform: 'tiktok',
          url: 'https://www.tiktok.com/@demo_creator/video/1',
          caption: 'Video 1',
          publishedAt: '2026-11-05T10:00:00.000Z',
          publishedMonth: '2026-11',
          views: 15000,
          likes: 500,
          comments: 20,
          shares: 10,
          durationSec: 45,
          thumbnailUrl: null,
        },
        {
          id: 'facebook:1',
          channelId: fb.id,
          platform: 'facebook',
          url: 'https://www.facebook.com/reel/1',
          caption: 'Reel 1',
          publishedAt: '2026-11-08T10:00:00.000Z',
          publishedMonth: '2026-11',
          views: 8000,
          likes: 200,
          comments: 15,
          shares: 5,
          durationSec: 30,
          thumbnailUrl: null,
        },
      ]);

      const dash = db.getDashboard({ month: '2026-11' });
      expect(dash.summary.periodVideos).toBe(2);
      expect(dash.summary.periodViews).toBe(23000);
      expect(dash.summary.periodLikes).toBe(700);
      expect(dash.summary.periodComments).toBe(35);

      const group = dash.doctors.find((d) => d.doctorGroup === 'Demo Creator')!;
      expect(group.channelsCount).toBe(2);
      expect(group.totalViews).toBe(23000);
      expect(group.totalLikes).toBe(700);
      expect(group.totalComments).toBe(35);
    } finally {
      cleanup();
    }
  });
});
