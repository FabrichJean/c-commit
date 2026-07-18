export interface CommitFileChange {
  name: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

export interface GitCommit {
  id: string;
  hash: string;
  subject: string;
  body: string;
  timestamp: string;
  author: string;
  stage: string;
  affectedFiles: CommitFileChange[];
}

export interface ClaudeMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

export interface ClaudeChatSession {
  id: string;
  title: string;
  projectContext: string;
  timestamp: string;
  messages: ClaudeMessage[];
}

export interface ProjectFileInfo {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  content?: string;
}

export interface ProjectStructure {
  projectName: string;
  files: ProjectFileInfo[];
}

export type TuiTheme = 'cyan' | 'amber' | 'green' | 'violet' | 'gray';

export interface TuiSettings {
  theme: TuiTheme;
  commitCount: number;
  timelineStart: string;
  timelineEnd: string;
  projectName: string;
}
