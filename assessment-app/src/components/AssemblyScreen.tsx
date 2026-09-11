'use client';

import React, { useState, useEffect } from 'react';
import { Question } from '../types';
import { CAMERA_PROCTORING_ENABLED } from '../config';

interface AssemblyScreenProps {
  name: string;
  attemptId: string;
  questions: Question[];
  onProceed: () => void;
  onReset: () => void;
}

export default function AssemblyScreen({ name, attemptId, questions, onProceed, onReset }: AssemblyScreenProps) {
  const [hasCamera, setHasCamera] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const checkFullscreen = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', checkFullscreen);
    return () => {
      document.removeEventListener('fullscreenchange', checkFullscreen);
    };
  }, []);

  const requestCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach(track => track.stop()); // close it immediately
      setHasCamera(true);
    } catch (err) {
      console.error('Camera access denied:', err);
      alert('Camera access is required for this integrity-monitored assessment. Please allow camera permissions.');
    }
  };

  const requestFullscreen = async () => {
    try {
      const docEl = document.documentElement;
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      }
    } catch (err) {
      console.error('Error entering fullscreen:', err);
    }
  };

  const formatSectionName = (bank: string, section: string, level?: string | null) => {
    if (bank === 'english') {
      switch (section) {
        case 'grammar': return 'English: Grammar';
        case 'sentence_correction': return 'English: Sentence Correction';
        case 'macro': return 'English: Macro Editing';
        case 'reading': return 'English: Reading Comprehension';
        case 'closure': return 'English: Case Closure Notes';
        default: return 'English Section';
      }
    } else if (bank === 'attention') {
      if (section === 'closure') return 'Attention to Detail: Case Closure';
      return `Attention to Detail (${level || 'L1'})`;
    } else if (bank === 'critical') {
      return 'Critical Thinking Cases';
    }
    return `${bank} - ${section}`;
  };

  // Group and count categories
  const breakdown: Record<string, number> = {};
  questions.forEach(q => {
    const label = formatSectionName(q.bank, q.section, q.level);
    breakdown[label] = (breakdown[label] || 0) + 1;
  });

  const canProceed = (CAMERA_PROCTORING_ENABLED ? hasCamera : true) && isFullscreen;

  return (
    <div className="w-full max-w-[500px] mx-auto animate-fade-in">
      <div className="bg-card backdrop-blur-md border border-[var(--card-border)] rounded-2xl p-8 md:p-10 shadow-2xl flex flex-col gap-6 relative overflow-hidden before:content-[''] before:absolute before:top-0 before:left-0 before:right-0 before:height-[3px] before:bg-linear-to-r before:from-[#4facfe] before:to-[#00f2fe]">
        
        <div className="text-center">
          <div className="w-14 h-14 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-3">
            <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
          <h2 className="text-2xl font-bold tracking-tight mb-1 text-slate-900">Attempt Registered!</h2>
          <p className="text-xs text-[var(--text-secondary)]">
            Your secure question bank has been assembled and frozen on the server.
          </p>
        </div>

        <div className="bg-slate-50 border border-[var(--card-border)] rounded-lg p-4 flex flex-col gap-2.5 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-600">Candidate:</span>
            <span className="font-semibold text-slate-900">{name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-600">Attempt ID:</span>
            <span className="font-mono font-semibold text-slate-900 text-xs">{attemptId}</span>
          </div>
          <div className="flex justify-between border-t border-slate-200 pt-2 mt-1">
            <span className="text-slate-500 font-medium">Questions:</span>
            <span className="font-bold text-accent">{questions.length} Questions</span>
          </div>
        </div>

        {/* Integrity Pre-flight checks */}
        <div className="border border-[var(--card-border)] rounded-lg p-4 bg-slate-50 flex flex-col gap-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">
            Security & Integrity Check:
          </h3>
          <div className="flex flex-col gap-2.5">
            {CAMERA_PROCTORING_ENABLED && (
              <div className="flex justify-between items-center bg-white p-2.5 rounded-md border border-slate-200">
                <span className="text-xs text-slate-700 font-medium">1. Webcam Monitoring</span>
                {hasCamera ? (
                  <span className="text-[11px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded">
                    Granted ✓
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={requestCamera}
                    className="text-xs font-semibold px-3 py-1 rounded bg-accent text-[#070a13] cursor-pointer hover:opacity-90 transition-all"
                  >
                    Grant Access
                  </button>
                )}
              </div>
            )}

            <div className="flex justify-between items-center bg-white p-2.5 rounded-md border border-slate-200">
              <span className="text-xs text-slate-700 font-medium">{CAMERA_PROCTORING_ENABLED ? '2. Fullscreen Mode' : 'Fullscreen Mode'}</span>
              {isFullscreen ? (
                <span className="text-[11px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded">
                  Active ✓
                </span>
              ) : (
                <button
                  type="button"
                  onClick={requestFullscreen}
                  className="text-xs font-semibold px-3 py-1 rounded bg-accent text-[#070a13] cursor-pointer hover:opacity-90 transition-all"
                >
                  Enter Fullscreen
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
            Secure Quota Breakdown:
          </h3>
          <ul className="flex flex-col gap-1.5 max-h-[120px] overflow-y-auto pr-1">
            {Object.entries(breakdown).map(([label, count]) => (
              <li key={label} className="text-[11px] bg-slate-50 border border-[var(--card-border)] px-3 py-2 rounded-lg flex justify-between">
                <span className="text-slate-700 font-medium">{label}</span>
                <span className="text-accent font-bold">{count} Qs</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onReset}
            className="flex-1 font-semibold text-[13px] py-3 rounded-lg bg-slate-100 border border-slate-200 text-slate-800 hover:bg-slate-200/80 cursor-pointer transition-all"
          >
            Reset Session
          </button>
          <button
            type="button"
            onClick={onProceed}
            disabled={!canProceed}
            className={`flex-1 font-semibold text-[13px] py-3 rounded-lg text-[#070a13] transition-all ${
              canProceed
                ? 'bg-linear-to-br from-[#4facfe] to-[#00f2fe] hover:-translate-y-0.5 hover:shadow-[0_4px_12px_rgba(0,242,254,0.25)] active:translate-y-0 cursor-pointer'
                : 'bg-slate-100 text-slate-400 border border-slate-200 opacity-50 cursor-not-allowed'
            }`}
          >
            Proceed to Test
          </button>
        </div>
      </div>
    </div>
  );
}

