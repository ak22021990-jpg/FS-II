'use client';

import React from 'react';
import { motion } from 'framer-motion';

interface QuestionHeaderProps {
  levelName: string;
  progressPercent: number;
  currentIdx: number;
  totalQuestions: number;
  cosmeticXp: number;
  animateXp: boolean;
  showZoneOverlay: boolean;
}

export default function QuestionHeader({
  levelName,
  progressPercent,
  currentIdx,
  totalQuestions,
  cosmeticXp,
  animateXp,
  showZoneOverlay,
}: QuestionHeaderProps) {
  return (
    <div className="flex flex-wrap justify-between items-center gap-4 pb-5 border-b border-slate-200">
      <div className="flex flex-col gap-1.5 flex-1 min-w-[200px]">
        <span className="text-sm font-bold uppercase tracking-wider text-accent">
          {levelName}
        </span>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-linear-to-r from-[#4facfe] to-[#00f2fe] rounded-full shadow-[0_0_8px_var(--accent-glow)] transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <span className="text-sm text-[var(--text-secondary)] font-semibold whitespace-nowrap">
            Q{currentIdx + 1} of {totalQuestions}
          </span>
        </div>
      </div>

      <div className="flex gap-3 items-center">
        {/* XP Badge */}
        <motion.div
          animate={{ scale: animateXp ? 1.15 : 1 }}
          className="flex items-center gap-2 px-4 py-2 rounded-full border border-amber-250 bg-amber-50 text-amber-700 font-bold text-sm"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="12 2 2 7 12 12 22 7 12 2" />
            <polyline points="2 12 12 17 22 12" />
            <polyline points="2 17 12 22 22 17" />
          </svg>
          <span>{cosmeticXp} XP</span>
        </motion.div>
      </div>
    </div>
  );
}
