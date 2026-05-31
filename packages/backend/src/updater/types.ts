export interface GitHubRelease {
  tag_name: string;
  name: string;
  html_url: string;
  prerelease: boolean;
  assets: GitHubAsset[];
  body?: string;
}

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
  content_type: string;
}

export interface UpdateInfo {
  version: string;
  releaseNotesUrl: string;
  assets: GitHubAsset[];
}
