'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Question, AnswersMap, HybridAnswer } from '../types';
import { CAMERA_PROCTORING_ENABLED } from '../config';
import { ZONE_CONFIG, ZONE_ORDER, getZoneKey } from '../data/zone-config';

// Sub-components and Hooks
import QuestionHeader from './test-screen/QuestionHeader';
import ScenarioBlock from './test-screen/ScenarioBlock';
import OptionsList from './test-screen/OptionsList';
import ZoneOverlays from './test-screen/ZoneOverlays';
import CaseFilePanel from './test-screen/CaseFilePanel';
import { useWebcamProctoring } from './test-screen/useWebcamProctoring';
import { useIntegrityMonitoring } from './test-screen/useIntegrityMonitoring';

interface TestScreenProps {
  questions: Question[];
  onSubmit: (answers: AnswersMap) => void;
  attemptId: string;
  gasUrl: string;
}

export default function TestScreen({ questions, onSubmit, attemptId, gasUrl }: TestScreenProps) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<AnswersMap>({});
  const [timerVal, setTimerVal] = useState(60);
  const [cosmeticXp, setCosmeticXp] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [animateXp, setAnimateXp] = useState(false);

  // Zone guidelines state
  const [showZoneOverlay, setShowZoneOverlay] = useState(false);
  const [activeZoneKey, setActiveZoneKey] = useState<string | null>(null);
  const [zoneQuestionCount, setZoneQuestionCount] = useState(0);
  const lastZoneKeyRef = useRef<string | null>(null);
  const [timerPaused, setTimerPaused] = useState(false);
  // Two-phase transition: 'complete' celebrates the finished zone, 'brief' introduces the next one.
  // First zone of the test skips 'complete' and shows 'brief' directly.
  const [overlayPhase, setOverlayPhase] = useState<'complete' | 'brief'>('brief');
  const [completedZoneKey, setCompletedZoneKey] = useState<string | null>(null);

  // Open-text state
  const [openTextValue, setOpenTextValue] = useState('');
  // Hybrid state
  const [hybridTextValue, setHybridTextValue] = useState('');

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Helper for silent logging
  const silentLog = useCallback((logType: string, details: Record<string, any>) => {
    if (!attemptId || !gasUrl) return;
    fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'logIntegrity',
        attemptId,
        logType,
        details: {
          timestamp: new Date().toISOString(),
          ...details
        }
      })
    }).catch(err => console.error('Silent log failed:', err));
  }, [attemptId, gasUrl]);

  // Hook for webcam proctoring
  const { faceStatus } = useWebcamProctoring(videoRef, silentLog);

  // Hook for candidate integrity tracking
  useIntegrityMonitoring(attemptId, questions[currentIdx]?.id, silentLog);

  // Restore state from LocalStorage on mount
  useEffect(() => {
    const savedIdx = localStorage.getItem('fs_current_index');
    if (savedIdx !== null) {
      const idx = parseInt(savedIdx);
      setCurrentIdx(idx);
      // Pre-set zone key so we skip overlay on resume
      if (idx > 0 && questions[idx]) {
        lastZoneKeyRef.current = getZoneKey(questions[idx]);
      }
    }

    const savedAns = localStorage.getItem('fs_answers');
    if (savedAns !== null) setAnswers(JSON.parse(savedAns));

    const savedXp = localStorage.getItem('fs_xp');
    if (savedXp !== null) setCosmeticXp(parseInt(savedXp));

    // Right click prevention
    const handleContextMenu = (e: MouseEvent) => e.preventDefault();
    document.addEventListener('contextmenu', handleContextMenu);

    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Integrity monitoring effects have been extracted to useIntegrityMonitoring hook

  // Webcam effects have been extracted to useWebcamProctoring hook

  const currentQuestion = questions[currentIdx];

  // Zone transition detection
  useEffect(() => {
    if (!currentQuestion) return;

    const zoneKey = getZoneKey(currentQuestion);
    if (zoneKey !== lastZoneKeyRef.current) {
      const prevZoneKey = lastZoneKeyRef.current;
      lastZoneKeyRef.current = zoneKey;

      const config = ZONE_CONFIG[zoneKey];
      if (config) {
        // Count questions in this zone
        let count = 0;
        for (let i = currentIdx; i < questions.length; i++) {
          if (getZoneKey(questions[i]) === zoneKey) count++;
          else break;
        }
        setZoneQuestionCount(count);
        setActiveZoneKey(zoneKey);
        // First zone → straight to brief. Subsequent zones → celebrate the completed one first.
        if (prevZoneKey && ZONE_CONFIG[prevZoneKey]) {
          setCompletedZoneKey(prevZoneKey);
          setOverlayPhase('complete');
        } else {
          setCompletedZoneKey(null);
          setOverlayPhase('brief');
        }
        setShowZoneOverlay(true);
        setTimerPaused(true);
      }
    }

    // Restore open_text / hybrid values from saved answers
    if (currentQuestion.response_type === 'open_text') {
      const saved = answers[currentQuestion.id];
      if (typeof saved === 'string') {
        setOpenTextValue(saved);
      } else if (currentQuestion.section === 'macro') {
        // Macro Editing stems embed the original macro as "Existing Macro:\n<text>" —
        // pre-fill it so the candidate edits in place instead of retyping from scratch.
        const marker = 'Existing Macro:\n';
        const idx = currentQuestion.stem.indexOf(marker);
        const prefill = idx !== -1 ? currentQuestion.stem.slice(idx + marker.length) : '';
        setOpenTextValue(prefill);
        if (prefill) {
          const updatedAnswers = { ...answers, [currentQuestion.id]: prefill };
          setAnswers(updatedAnswers);
          localStorage.setItem('fs_answers', JSON.stringify(updatedAnswers));
        }
      } else {
        setOpenTextValue('');
      }
    } else if (currentQuestion.response_type === 'hybrid') {
      const saved = answers[currentQuestion.id];
      if (saved && typeof saved === 'object' && !Array.isArray(saved) && 'text' in saved) {
        setHybridTextValue((saved as HybridAnswer).text);
      } else {
        setHybridTextValue('');
      }
    }
  }, [currentIdx, currentQuestion]);

  // Set up timer when current question changes (only when not paused by overlay)
  // Timer runs but does NOT auto-submit — user can take unlimited time
  useEffect(() => {
    if (!currentQuestion || timerPaused) return;

    // Timer configuration based on bank/section (for reference/logging only)
    let duration = 60;
    if (currentQuestion.bank === 'english') {
      duration = currentQuestion.section === 'reading' ? 180 : 60;
    } else if (currentQuestion.bank === 'attention') {
      duration = 120;
    } else if (currentQuestion.bank === 'critical') {
      duration = 180;
    }

    setTimerVal(duration);
    setErrorMsg(null);

    if (timerRef.current) clearInterval(timerRef.current);

    // Timer continues to count down but does NOT auto-submit
    timerRef.current = setInterval(() => {
      setTimerVal((prev) => {
        // Just decrement, don't auto-submit
        if (prev <= 0) {
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [currentIdx, currentQuestion, timerPaused]);

  const handleBeginZone = useCallback(() => {
    // From the 'complete' celebration screen, advance to the next zone's brief instead of closing.
    if (overlayPhase === 'complete') {
      setOverlayPhase('brief');
      return;
    }
    setShowZoneOverlay(false);
    setTimerPaused(false);
  }, [overlayPhase]);

  if (!currentQuestion) return null;

  const progressPercent = Math.round((currentIdx / questions.length) * 100);

  const levelName = currentQuestion.bank === 'attention' ? 'Level 2: Attention to Detail'
    : currentQuestion.bank === 'critical' ? 'Level 3: Critical Thinking'
    : 'Level 1: English Proficiency';

  const timerColor = timerVal <= 10 ? 'text-error border-error/30 bg-error/5'
    : timerVal <= 20 ? 'text-amber-500 border-amber-500/30 bg-amber-500/5'
    : 'text-accent border-accent/20';
  const pulseClass = timerVal <= 10 ? 'animate-pulse' : '';

  const currentSelection = answers[currentQuestion.id] || null;

  const handleOptionClick = (letter: string) => {
    const isMulti = currentQuestion.response_type === 'mcq_multi';

    if (currentQuestion.response_type === 'hybrid') {
      // For hybrid, store the MCQ selection while preserving text
      const existingHybrid = (currentSelection && typeof currentSelection === 'object' && !Array.isArray(currentSelection))
        ? currentSelection as HybridAnswer : { selected: '', text: hybridTextValue };
      const updatedAnswer: HybridAnswer = { ...existingHybrid, selected: letter };
      const updatedAnswers = { ...answers, [currentQuestion.id]: updatedAnswer };
      setAnswers(updatedAnswers);
      localStorage.setItem('fs_answers', JSON.stringify(updatedAnswers));
      return;
    }

    let newSelection: string | string[];

    if (isMulti) {
      const currentArr = Array.isArray(currentSelection) ? currentSelection : [];
      if (currentArr.includes(letter)) {
        newSelection = currentArr.filter((l) => l !== letter);
      } else {
        newSelection = [...currentArr, letter];
      }
    } else {
      newSelection = letter;
    }

    const updatedAnswers = { ...answers, [currentQuestion.id]: newSelection };
    setAnswers(updatedAnswers);
    localStorage.setItem('fs_answers', JSON.stringify(updatedAnswers));
  };

  const handleOpenTextChange = (value: string) => {
    setOpenTextValue(value);
    const updatedAnswers = { ...answers, [currentQuestion.id]: value };
    setAnswers(updatedAnswers);
    localStorage.setItem('fs_answers', JSON.stringify(updatedAnswers));
  };

  const handleHybridTextChange = (value: string) => {
    setHybridTextValue(value);
    const existingHybrid = (currentSelection && typeof currentSelection === 'object' && !Array.isArray(currentSelection))
      ? currentSelection as HybridAnswer : { selected: '', text: '' };
    const updatedAnswer: HybridAnswer = { ...existingHybrid, text: value };
    const updatedAnswers = { ...answers, [currentQuestion.id]: updatedAnswer };
    setAnswers(updatedAnswers);
    localStorage.setItem('fs_answers', JSON.stringify(updatedAnswers));
  };

  const handleNext = (isTimeout = false) => {
    if (!isTimeout) {
      if (currentQuestion.response_type === 'open_text' && !openTextValue.trim()) {
        return setErrorMsg('Please type your corrected answer to proceed.');
      } else if (currentQuestion.response_type === 'hybrid') {
        const hybrid = currentSelection as HybridAnswer | null;
        if (!hybrid?.selected) return setErrorMsg('Please select a case status to proceed.');
        if (!hybridTextValue.trim()) return setErrorMsg('Please write a closure note to proceed.');
      } else if (!currentSelection) {
        return setErrorMsg('Please select an answer to proceed.');
      }
    }

    setErrorMsg(null);

    // Save and persist Index
    const nextIdx = currentIdx + 1;
    localStorage.setItem('fs_current_index', nextIdx.toString());

    // Cosmetic XP increment
    if (!isTimeout) {
      setCosmeticXp((prev) => {
        const val = prev + 100;
        localStorage.setItem('fs_xp', val.toString());
        return val;
      });
      setAnimateXp(true);
      setTimeout(() => setAnimateXp(false), 200);
    }

    if (nextIdx >= questions.length) {
      if (timerRef.current) clearInterval(timerRef.current);
      onSubmit(answers);
    } else {
      setCurrentIdx(nextIdx);
    }
  };

  const hasTabs = !!currentQuestion.tabs && currentQuestion.tabs.length > 0;
  const isOpenText = currentQuestion.response_type === 'open_text';
  const isHybrid = currentQuestion.response_type === 'hybrid';
  const isMulti = currentQuestion.response_type === 'mcq_multi';
  const showMCQ = !isOpenText; // hybrid + mcq_single + mcq_multi all show MCQ

  // For hybrid, get selected letter
  const hybridSelected = (isHybrid && currentSelection && typeof currentSelection === 'object' && !Array.isArray(currentSelection))
    ? (currentSelection as HybridAnswer).selected : null;

  // Get active zone config for overlay
  const activeZoneConfig = activeZoneKey ? ZONE_CONFIG[activeZoneKey] : null;
  const completedZoneConfig = completedZoneKey ? ZONE_CONFIG[completedZoneKey] : null;
  const completedZoneIndex = completedZoneKey ? ZONE_ORDER.indexOf(completedZoneKey) : -1;
  const zonesDoneCount = completedZoneIndex >= 0 ? completedZoneIndex + 1 : 0;
  const totalZones = ZONE_ORDER.length;

  return (
    <>
      <motion.div
        layout
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className="w-full min-h-screen flex flex-col relative bg-transparent"
      >
        <div className="absolute top-0 left-0 right-0 h-[4px] bg-linear-to-r from-[#4facfe] to-[#00f2fe] z-10" />
        
        <div className={`w-full mx-auto px-6 md:px-12 py-8 flex flex-col gap-8 ${hasTabs ? 'max-w-[1600px]' : 'max-w-[1200px]'}`}>
          
          {/* Zone Guidelines Overlay */}
          <ZoneOverlays
            showZoneOverlay={showZoneOverlay}
            overlayPhase={overlayPhase}
            completedZoneConfig={completedZoneConfig}
            activeZoneConfig={activeZoneConfig}
            zoneQuestionCount={zoneQuestionCount}
            zonesDoneCount={zonesDoneCount}
            totalZones={totalZones}
            onBeginZone={handleBeginZone}
          />

          {/* Header Section */}
          <QuestionHeader
            levelName={levelName}
            progressPercent={progressPercent}
            currentIdx={currentIdx}
            totalQuestions={questions.length}
            cosmeticXp={cosmeticXp}
            animateXp={animateXp}
            timerColor={timerColor}
            pulseClass={pulseClass}
            showZoneOverlay={showZoneOverlay}
            timerVal={timerVal}
          />

          {/* Main Body Columns */}
          <div className={`grid gap-6 items-start ${hasTabs ? 'grid-cols-1 lg:grid-cols-[1.6fr_1fr]' : 'grid-cols-1'}`}>

            {/* Dashboard (Left Column) */}
            {hasTabs && currentQuestion.tabs && (
              <div className="animate-fade-in w-full">
                {(currentQuestion.section === 'reading' || currentQuestion.bank === 'critical') ? (
                  <ScenarioBlock currentQuestion={currentQuestion} />
                ) : (
                  <CaseFilePanel
                    tabs={currentQuestion.tabs}
                    tables={currentQuestion.tables}
                    caseTitle={currentQuestion.case_title}
                    caseId={currentQuestion.case_id}
                  />
                )}
              </div>
            )}

            {/* Question and options (Right Column) */}
            <div className={`flex flex-col gap-5 w-full ${hasTabs ? 'lg:sticky lg:top-6' : ''}`}>
              {currentQuestion.bank === 'critical' && !hasTabs && (
                <div className="bg-amber-500/5 border border-amber-500/20 text-amber-700 text-xs leading-relaxed rounded-lg p-3">
                  Case file not yet available for this question — noted for follow-up. Answer based on the information provided below.
                </div>
              )}
              <h3 className="text-xl font-bold leading-relaxed text-slate-900 whitespace-pre-wrap">
                {/* Macro: stem embeds "Existing Macro:" block, but that text is already
                    pre-filled editable in the answer box below — show scenario only
                    so the broken macro doesn't appear twice. */}
                {currentQuestion.section === 'macro'
                  ? currentQuestion.stem.split('Existing Macro:\n')[0].trimEnd()
                  : currentQuestion.stem}
              </h3>

              {/* MCQ Options (for mcq_single, mcq_multi, hybrid) */}
              {showMCQ && currentQuestion.options.length > 0 && (
                <OptionsList
                  currentQuestion={currentQuestion}
                  currentSelection={currentSelection}
                  isMulti={isMulti}
                  isHybrid={isHybrid}
                  hybridSelected={hybridSelected}
                  onOptionClick={handleOptionClick}
                />
              )}

              {/* Open Text Textarea (Sentence Correction / Macro) */}
              {isOpenText && (
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-bold uppercase tracking-[1px] text-accent">
                    {currentQuestion.section === 'macro'
                      ? 'Fix the grammar errors in the macro below'
                      : 'Your Answer'}
                  </label>
                  <textarea
                    value={openTextValue}
                    onChange={(e) => handleOpenTextChange(e.target.value)}
                    rows={6}
                    placeholder="Type your corrected version here..."
                    className="w-full bg-slate-50 border border-[var(--card-border)] rounded-xl px-5 py-4 text-slate-900 text-base leading-relaxed font-medium outline-none transition-all resize-y"
                  />
                </div>
              )}

              {/* Hybrid: Closure Note Textarea (below MCQ) */}
              {isHybrid && (
                <div className="flex flex-col gap-2 border-t border-dashed border-slate-200 pt-4 mt-2">
                  <label className="text-sm font-bold uppercase tracking-[1px] text-accent">
                    Closure Note
                  </label>
                  <textarea
                    value={hybridTextValue}
                    onChange={(e) => handleHybridTextChange(e.target.value)}
                    rows={5}
                    placeholder="Write a professional closure note for this case..."
                    className="w-full bg-slate-50 border border-[var(--card-border)] rounded-xl px-5 py-4 text-slate-900 text-base leading-relaxed font-medium outline-none transition-all resize-y"
                  />
                </div>
              )}

              {errorMsg && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-700 p-3 rounded-lg text-xs leading-relaxed">
                  {errorMsg}
                </div>
              )}

              <button
                onClick={() => handleNext(false)}
                className="flex justify-center items-center gap-2 font-bold text-lg p-4 rounded-xl bg-linear-to-br from-[#4facfe] to-[#00f2fe] text-[#070a13] cursor-pointer hover:-translate-y-0.5 active:translate-y-0 transition-transform"
              >
                <span>{currentIdx === questions.length - 1 ? 'Submit Assessment' : 'Submit Answer'}</span>
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Floating PIP Webcam Proctor Widget */}
      {CAMERA_PROCTORING_ENABLED && (
        <div className="fixed bottom-4 right-4 z-50 bg-white/95 backdrop-blur-md border border-slate-200 rounded-xl p-2 shadow-2xl flex flex-col gap-2 w-[160px] animate-fade-in transition-all hover:shadow-xl">
          <div className="relative aspect-video w-full bg-slate-100 rounded-lg overflow-hidden border border-slate-200">
            <video
              ref={videoRef}
              muted
              playsInline
              className="w-full h-full object-cover scale-x-[-1]"
            />
            <div className="absolute top-1.5 left-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/90 border border-slate-200 backdrop-blur-xs">
              <span className={`w-1.5 h-1.5 rounded-full ${
                faceStatus === 'ok' ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' :
                faceStatus === 'detecting' ? 'bg-amber-500 shadow-[0_0_8px_#f59e0b]' :
                'bg-red-500 shadow-[0_0_8px_#ef4444]'
              }`} />
              <span className="text-[8px] font-bold text-slate-700 uppercase tracking-wider">
                {faceStatus === 'ok' ? 'Secure' :
                 faceStatus === 'detecting' ? 'Scan' :
                 faceStatus === 'no_face' ? 'No Face' : 'Multi-Face'}
              </span>
            </div>
          </div>
          <div className="text-[9px] text-slate-600 font-bold tracking-wider text-center uppercase">
            Proctor Active
          </div>
        </div>
      )}
    </>
  );
}
