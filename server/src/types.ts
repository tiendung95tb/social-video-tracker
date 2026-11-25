export type Platform = 'tiktok' | 'facebook';

export interface Channel {
  id: number;
  platform: Platform;
  handle: string;
  url: string;
  displayName: string;
  doctorGroup: string;
  ugOwner: string;
  specialty: string;
  cooperationStatus: string;
  sheetRow: number | null;
  enabled: boolean;
  profileVideoCount: number | null;
  profileFollowers: number | null;
  lastScannedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface VideoRecord {
  id: string;
  channelId: number;
  platform: Platform;
  url: string;
  caption: string;
  publishedAt: string | null;
  publishedMonth: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  durationSec: number | null;
  thumbnailUrl: string | null;
  lastSeenAt: string;
}

export interface ScanRun {
  id: number;
  platform: Platform | 'all';
  actorId: string;
  apifyRunId: string | null;
  sinceDate: string;
  channelsCount: number;
  channelIds?: number[];
  videosFetched: number;
  videosInPeriod: number;
  costUsd: number;
  status: 'running' | 'dry_run' | 'succeeded' | 'partial' | 'failed';
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface TrackerSettings {
  hasApifyToken: boolean;
  apifyTokenMasked: string;
  tiktokActorId: string;
  facebookActorId: string;
  monthlyBudgetUsd: number;
  perRunBudgetUsd: number;
  defaultMaxVideosTiktok: number;
  defaultMaxVideosFacebook: number;
  googleSheetUrl: string;
  googleSheetTab: string;
  exportSheetUrl: string;
}

export interface ApifyAccountLimits {
  username: string | null;
  monthlyUsageUsd: number | null;
  maxMonthlyUsageUsd: number | null;
  remainingUsd: number | null;
  planName: string | null;
  checkedAt: string;
  error?: string;
}

export interface ChannelMonthlyRow {
  channel: Channel;
  periodVideos: number;
  periodViews: number;
  periodLikes: number;
  periodComments: number;
  periodShares: number;
  avgViews: number;
  allTimeTrackedVideos: number;
  allTimeTrackedViews: number;
  latestVideoAt: string | null;
}

export interface DoctorMonthlyRow {
  doctorGroup: string;
  channelsCount: number;
  platforms: Platform[];
  tiktokVideos: number;
  tiktokViews: number;
  facebookVideos: number;
  facebookViews: number;
  totalVideos: number;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  avgViews: number;
}

export interface DashboardPayload {
  month: string;
  sinceDate: string;
  generatedAt: string;
  summary: {
    totalChannels: number;
    enabledChannels: number;
    tiktokChannels: number;
    facebookChannels: number;
    periodVideos: number;
    periodViews: number;
    periodLikes: number;
    periodComments: number;
    periodShares: number;
    tiktokPeriodVideos: number;
    tiktokPeriodViews: number;
    tiktokPeriodLikes: number;
    tiktokPeriodComments: number;
    facebookPeriodVideos: number;
    facebookPeriodViews: number;
    facebookPeriodLikes: number;
    facebookPeriodComments: number;
    avgViewsPerVideo: number;
    monthSpendUsd: number;
    monthlyBudgetUsd: number;
    remainingLocalBudgetUsd: number;
  };
  settings: TrackerSettings;
  apifyLimits: ApifyAccountLimits | null;
  channels: ChannelMonthlyRow[];
  doctors: DoctorMonthlyRow[];
  recentRuns: ScanRun[];
  activeRuns: ScanRun[];
}
