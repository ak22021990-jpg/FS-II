import React from 'react';
import { Question } from '../types';

export interface ZoneExample {
  before?: string;
  after?: string;
  note?: string;
}

export interface ZoneConfig {
  badge: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
  whatToDo: string[];
  example?: ZoneExample;
}

export const ZONE_CONFIG: Record<string, ZoneConfig> = {
  'english/grammar': {
    badge: 'Zone 1 of 7',
    title: 'English: Grammar',
    desc: 'Pick the grammatically correct option in each multiple-choice question.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-7 h-7">
        <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    ),
    whatToDo: [
      'Read the sentence carefully.',
      'Choose the option that is grammatically correct.',
      'Watch for subject-verb agreement, tense, and articles (a/an/the).',
    ],
    example: {
      before: 'Neither the manager nor the agents ___ available.',
      after: '"were" — the verb agrees with the nearest subject ("agents").',
    },
  },
  'english/sentence_correction': {
    badge: 'Zone 2 of 7',
    title: 'English: Sentence Correction',
    desc: 'Rewrite a poorly written sentence with correct grammar, punctuation, and a professional tone.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-7 h-7">
        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    ),
    whatToDo: [
      'Read the original sentence in the question.',
      'Type the fixed version in the answer box.',
      'Fix spelling, punctuation, and word choice — keep the meaning.',
    ],
    example: {
      before: 'the customer are angry about there refund not been process',
      after: 'The customer is angry that their refund has not been processed.',
    },
  },
  'english/macro': {
    badge: 'Zone 3 of 7',
    title: 'English: Macro Editing',
    desc: 'Improve a canned customer-service reply so it reads correctly and personally.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-7 h-7">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
      </svg>
    ),
    whatToDo: [
      'The existing macro text is pre-filled in the answer box.',
      'Edit it in place — fix grammar, tone, and clarity.',
      'Make it warm and personal, not robotic.',
    ],
    example: {
      before: 'Dear valued customer, we regret to hear about you\'re issue. we will look into it.',
      after: 'Hi [Customer Name], I\'m sorry to hear about the issue you\'re facing. I\'ve reviewed your case and will follow up shortly.',
    },
  },
  'english/reading': {
    badge: 'Zone 4 of 7',
    title: 'English: Reading Comprehension',
    desc: 'Read a customer email/scenario, then answer questions about its content.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-7 h-7">
        <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" /><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
      </svg>
    ),
    whatToDo: [
      'The scenario appears on the left panel.',
      'Read it fully, then answer the questions on the right.',
      'You can re-open the scenario any time during the questions.',
    ],
    example: {
      note: 'Tip: focus on dates, amounts, and what the customer is asking for — most questions test those details.',
    },
  },
  'attention/closure': {
    badge: 'Zone 5 of 7',
    title: 'Attention to Detail: Case Closure',
    desc: 'Pick the correct case status and write a short professional closure note.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-7 h-7">
        <path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    ),
    whatToDo: [
      'Read the case summary.',
      'Choose the correct status: Open, Pending, or Solved.',
      'Write a 1-2 sentence closure note stating what was done and any reference IDs.',
    ],
    example: {
      note: 'Status: Solved · Note: "Refund of $50 processed on 05-Jul-2026 (Ref #REF-2001). Customer notified via email. Case closed."',
    },
  },
  'attention/L1': {
    badge: 'Zone 6 of 7',
    title: 'Attention to Detail (L1)',
    desc: 'Spot missing info or mismatches inside a single case dashboard.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-7 h-7">
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    ),
    whatToDo: [
      'The case dashboard appears on the left panel.',
      'Click any card to expand it and read the details.',
      'Compare fields across cards to find missing or inconsistent values.',
    ],
    example: {
      note: 'If the Transaction card shows $500 but the Invoice card shows $600, that is a discrepancy worth flagging.',
    },
  },
  'critical/': {
    badge: 'Zone 7 of 7',
    title: 'Critical Thinking Cases',
    desc: 'Pick the best next action in a fraud investigation scenario.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-7 h-7">
        <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
      </svg>
    ),
    whatToDo: [
      'Read the case scenario/case file carefully.',
      'Weigh risk signals, evidence, and customer impact.',
      'Choose the option that follows correct escalation and safety steps.',
    ],
    example: {
      note: 'Login from a new country + failed OTP + immediate password reset → freeze account, escalate to Fraud Ops, contact customer through a verified channel.',
    },
  },
};

export const ZONE_ORDER: string[] = [
  'english/grammar',
  'english/sentence_correction',
  'english/macro',
  'english/reading',
  'attention/closure',
  'attention/L1',
  'critical/',
];

export function getZoneKey(q: Question): string {
  if (q.bank === 'english') return 'english/' + q.section;
  if (q.bank === 'attention' && q.section === 'closure') return 'attention/closure';
  if (q.bank === 'attention') return 'attention/' + (q.level || '');
  if (q.bank === 'critical') return 'critical/';
  return q.bank + '/' + (q.section || '');
}
