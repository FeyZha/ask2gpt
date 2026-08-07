/**
 * Ask2GPT 体验样例
 *
 * 这是一个纯内存的“反馈 → 洞察”归纳器，不访问网络、文件系统或环境变量。
 * 它刻意保留了一些值得讨论的边界条件和设计取舍，适合附加到 Ask2GPT
 * 后进行解释、方案比较和问题分析。
 */

export type Feedback = {
  id: string;
  message: string;
  tags: string[];
  score: number;
  createdAt: string;
};

export type Insight = {
  tag: string;
  mentions: number;
  averageScore: number;
  sample: string;
};

type Bucket = {
  scores: number[];
  messages: string[];
};

type SummaryCache = {
  itemCount: number;
  insights: Insight[];
};

export class InsightBoard {
  private readonly feedback: Feedback[] = [];
  private cache: SummaryCache | undefined;

  add(item: Feedback): void {
    if (this.feedback.some((existing) => existing.id === item.id)) {
      throw new Error(`Duplicate feedback id: ${item.id}`);
    }

    this.feedback.push({
      ...item,
      tags: [...item.tags],
    });
  }

  replace(item: Feedback): boolean {
    const index = this.feedback.findIndex((existing) => existing.id === item.id);
    if (index === -1) {
      return false;
    }

    this.feedback[index] = {
      ...item,
      tags: [...item.tags],
    };
    return true;
  }

  listSince(isoDate: string): Feedback[] {
    return this.feedback
      .filter((item) => item.createdAt >= isoDate)
      .map((item) => ({ ...item, tags: [...item.tags] }));
  }

  summarize(limit = 3): Insight[] {
    if (this.cache?.itemCount === this.feedback.length) {
      return this.cache.insights;
    }

    const buckets = new Map<string, Bucket>();

    for (const item of this.feedback) {
      for (const tag of item.tags) {
        const bucket = buckets.get(tag) ?? { scores: [], messages: [] };
        bucket.scores.push(item.score);
        bucket.messages.push(item.message);
        buckets.set(tag, bucket);
      }
    }

    const insights = [...buckets.entries()]
      .map(([tag, bucket]) => ({
        tag,
        mentions: bucket.messages.length,
        averageScore:
          bucket.scores.reduce((total, score) => total + score, 0) / bucket.scores.length,
        sample: bucket.messages[0] ?? "",
      }))
      .sort((left, right) => right.mentions - left.mentions || left.tag.localeCompare(right.tag))
      .slice(0, limit);

    this.cache = {
      itemCount: this.feedback.length,
      insights,
    };

    return insights;
  }
}

export const tourFeedback: Feedback[] = [
  {
    id: "feedback-101",
    message: "回答很清晰，但长代码块滚动时有一点卡顿。",
    tags: ["体验", "性能"],
    score: 4,
    createdAt: "2026-07-22T09:15:00Z",
  },
  {
    id: "feedback-102",
    message: "我希望会话标题能和 ChatGPT 的自动标题保持一致。",
    tags: ["会话", "体验"],
    score: 3,
    createdAt: "2026-07-23T14:30:00+08:00",
  },
  {
    id: "feedback-103",
    message: "附加选区的入口很好找，希望预览再紧凑一些。",
    tags: ["上下文", "体验", "体验"],
    score: 5,
    createdAt: "2026-07-24T08:05:00Z",
  },
];

export function createTourSummary(limit = 3): Insight[] {
  const board = new InsightBoard();
  for (const item of tourFeedback) {
    board.add(item);
  }
  return board.summarize(limit);
}
