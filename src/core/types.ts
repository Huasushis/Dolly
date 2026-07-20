// 裁剪矩形
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Block 主体
export interface Block {
  id: string;                    // crypto.randomUUID() 转 hex（去掉横线）
  timestamp: number;             // Date.now()
  description: string;           // 人/日志可读描述
  source: string;                // 来源 module id
  content: any[];                // 数据项数组（框架不解析内部）
  tensity: number;               // 强度，标准值 1.0
  repeat_count?: number;         // 框架添加：重复次数
  extra_body?: Record<string, any>; // 预留扩展字段
}

// Module 返回的原始 Block（框架处理前）
export interface RawBlock {
  description: string;
  source: string;
  content: any[];               // 可包含原始多媒体（url/base64/file）
  tensity?: number;             // 默认 1.0
  extra_body?: Record<string, any>;
}

// Media 对象
export interface Media {
  id: string;
  mimeType: string;
  localPath?: string;
  url?: string;
  ossObjectKey?: string;
  width?: number;
  height?: number;
  duration?: number;
  size: number;
  createdAt: number;
  refCount: number;
}

// 调度配置
export interface ScheduleConfig {
  initialIntervalMs: number;
  minIntervalMs: number;
  maxIntervalMs: number;
}

// Module 配置
export interface ModuleConfig {
  id: string;
  extension: string;
  inputPages: string[];
  outputPages: string[];
  schedule?: Partial<ScheduleConfig>;
  config?: Record<string, any>;
}

// 实例配置
export interface DollyConfig {
  name: string;
  dataDir: string;
  llm: Record<string, { base_url: string; api_key: string; model: string }>;
  pages: Array<{ id: string }>;
  modules: ModuleConfig[];
  logging: { level: string };
}

// Premise 集合
export interface PremiseCollection {
  upstream: Array<{ moduleId: string; inputPremise: string; outputPremise: string }>;
  downstream: Array<{ moduleId: string; inputPremise: string; outputPremise: string }>;
}

// 执行输入
export interface ExecuteInput {
  blocks: Block[];
  adjacentPremises: PremiseCollection;
}
