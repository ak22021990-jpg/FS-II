/**
 * Fraud Support Assessment Backend
 * Google Apps Script Web App
 * 
 * Target Sheets:
 * - 'Attempts': Logs candidate metadata and their frozen question set IDs.
 * - 'Responses': Logs candidate submitted answers.
 * - 'Logs': Logs candidate integrity/violation events.
 */

// --- CONFIGURATION ---
const QUOTAS = {
  "grammar": {
    "count": 4,
    "unit": "questions"
  },
  "sentence_correction": {
    "count": 3,
    "unit": "questions"
  },
  "macro": {
    "count": 3,
    "unit": "questions"
  },
  "reading": {
    "count": 3,
    "unit": "questions"
  },
  "closure": {
    "count": 3,
    "unit": "questions"
  },
  "attention_l1": {
    "count": 2,
    "unit": "cases"
  },
  "critical": {
    "count": 2,
    "unit": "cases"
  }
};

// Simple password/token for Recruiter Admin API requests
const ADMIN_TOKEN = "FS_RECRUITER_SECRET_2026";

function checkAdminAuth(token) {
  return token === ADMIN_TOKEN;
}

// Report-readiness allowlist: any Attempts.Status not in this list is treated as "not ready yet"
const READY_STATUSES = ['submitted', 'graded', 'emailed'];

// --- LLM AUTOGRADING CONFIG ---
// API keys are read from Script Properties (Project Settings > Script Properties),
// never hardcoded in source -- set OPENROUTER_API_KEY there.
// OPENROUTER_API_KEY is the single key used for all LLM calls via OpenRouter.
const OPENROUTER_API_KEY = PropertiesService.getScriptProperties().getProperty("OPENROUTER_API_KEY")
  || PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY") || "";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "meta-llama/llama-3.1-8b-instruct";

/**
 * @deprecated Phase 10 -- replaced by evaluateWithRubric in backend/AsyncGrading.gs; retained for one release cycle for rollback (per RESEARCH.md § State of the Art). Do not call from new code.
 *
 * Grades open-text and hybrid text responses in parallel using Gemini API, with fallback to OpenRouter/OpenAI.
 * @param {Array} gradingRequests - Array of objects: { qId, prompt, answer }
 * @returns {Object} Map of qId -> isCorrect (boolean)
 */
function evaluateOpenTextBatch(gradingRequests) {
  const results = {};
  if (!gradingRequests || gradingRequests.length === 0) return results;
  
  const systemInstruction = "You are an expert English grader. Evaluate the candidate's response based on the question prompt. Score 1 if grammar is perfect, tone is professional, and all instructions are followed. Score 0 if there are any significant errors or missed instructions. Output strictly valid JSON like {\"score\": 1} or {\"score\": 0}.";
  
  if (!OPENROUTER_API_KEY) {
    gradingRequests.forEach(req => { results[req.qId] = true; });
    return results;
  }

  // All grading goes through OpenRouter (OpenAI-compatible endpoint)
  const fetchRequests = gradingRequests.map(req => {
    const payload = {
      "model": OPENROUTER_MODEL,
      "messages": [
        {"role": "system", "content": systemInstruction},
        {"role": "user", "content": "Question/Context:\\n" + req.prompt + "\\n\\nCandidate Answer:\\n" + req.answer}
      ],
      "temperature": 0.1,
      "response_format": { "type": "json_object" }
    };
    return {
      "url": OPENROUTER_URL,
      "method": "post",
      "headers": {
        "Authorization": "Bearer " + OPENROUTER_API_KEY,
        "HTTP-Referer": "https://github.com/anomalyco/FS-gamified-assessment",
        "X-Title": "FS Gamified Assessment"
      },
      "contentType": "application/json",
      "payload": JSON.stringify(payload),
      "muteHttpExceptions": true
    };
  });

  try {
    const responses = UrlFetchApp.fetchAll(fetchRequests);
    responses.forEach((res, index) => {
      const qId = gradingRequests[index].qId;
      if (res.getResponseCode() === 200) {
        try {
          const json = JSON.parse(res.getContentText());
          const textResponse = json.choices[0].message.content;
          const parsedScore = JSON.parse(textResponse);
          results[qId] = parsedScore.score === 1;
        } catch (e) { results[qId] = true; }
      } else {
        console.error("OpenRouter grading error for " + qId + ":", res.getResponseCode(), res.getContentText());
        results[qId] = true;
      }
    });
  } catch (err) {
    gradingRequests.forEach(req => { results[req.qId] = true; });
  }

  return results;
}

// --- WEB APP ROUTERS ---

function doGet(e) {
  const params = e.parameter;
  const action = params.action;
  
  try {
    if (action === "checkAttempt") {
      return jsonResponse(handleCheckAttempt(params.attemptId));
    } else if (action === "getAttemptReport") {
      return jsonResponse(handleGetAttemptReport(params.attemptId, params.token));
    } else if (action === "adminListCandidates") {
      return jsonResponse(handleAdminListCandidates(params.token));
    } else if (action === "getAttemptTranscript") {
      return jsonResponse(handleGetAttemptTranscript(params.attemptId, params.token));
    } else if (action === "adminAnalytics") {
      return jsonResponse(handleAdminAnalytics(params.token));
    }
    
    return jsonResponse({ error: "Invalid action or method" }, 400);
  } catch (err) {
    return jsonResponse({ error: err.toString() }, 500);
  }
}

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ error: "Malformed JSON payload" }, 400);
  }
  
  const action = data.action;
  
  try {
    // Initialize Sheets on first run
    initSheets();
    
    if (action === "startAttempt") {
      return jsonResponse(handleStartAttempt(data.name, data.email));
    } else if (action === "submitAnswers") {
      return jsonResponse(handleSubmitAnswers(data.attemptId, data.answers));
    } else if (action === "logIntegrity") {
      return jsonResponse(handleLogIntegrity(data.attemptId, data.logType, data.details));
    } else if (action === "adminResetAttempt") {
      return jsonResponse(handleAdminResetAttempt(data.email, data.token));
    } else if (action === "overrideVerdict") {
      return jsonResponse(handleOverrideVerdict(data.attemptId, data.questionId, data.newVerdict, data.token));
    } else if (action === "regradeAttempt") {
      return jsonResponse(handleRegradeAttempt(data.attemptId, data.token));
    }

    return jsonResponse({ error: "Invalid action" }, 400);
  } catch (err) {
    return jsonResponse({ error: err.toString() }, 500);
  }
}

function jsonResponse(obj, statusCode = 200) {
  const output = ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
  
  // Apps Script Web App standard CORS headers are handled automatically,
  // but returning the text output works well for fetch requests.
  return output;
}

// --- DATABASE / SHEET INITIALIZATION ---

function initSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. Attempts Sheet
  let attemptsSheet = ss.getSheetByName("Attempts");
  if (!attemptsSheet) {
    attemptsSheet = ss.insertSheet("Attempts");
    attemptsSheet.appendRow(["AttemptID", "Name", "Email", "StartTime", "EndTime", "Status", "FrozenQuestionIDs", "OverallScore", "LanguageScore", "ResearchScore", "CriticalScore", "ViolationCount", "RecommendationTier", "NarrativeInsight", "UngradedCount"]);
    attemptsSheet.getRange("A1:O1").setFontWeight("bold").setBackground("#e2e8f0");
  }
  
  // 2. Responses Sheet
  let responsesSheet = ss.getSheetByName("Responses");
  if (!responsesSheet) {
    responsesSheet = ss.insertSheet("Responses");
    responsesSheet.appendRow(["AttemptID", "QuestionID", "SubmittedAnswer", "IsCorrect", "Timestamp"]);
    responsesSheet.getRange("A1:E1").setFontWeight("bold").setBackground("#e2e8f0");
  }
  
  // 3. IntegrityLogs Sheet
  let logsSheet = ss.getSheetByName("IntegrityLogs");
  if (!logsSheet) {
    logsSheet = ss.insertSheet("IntegrityLogs");
    logsSheet.appendRow(["AttemptID", "LogType", "Details", "Timestamp"]);
    logsSheet.getRange("A1:D1").setFontWeight("bold").setBackground("#e2e8f0");
  }

  // 4. PendingGrading Sheet (async grading queue -- drained by AsyncGrading.gs)
  let pendingSheet = ss.getSheetByName("PendingGrading");
  if (!pendingSheet) {
    pendingSheet = ss.insertSheet("PendingGrading");
    pendingSheet.appendRow(["AttemptID", "SubmittedAnswersJSON", "EnqueuedAt", "Stage", "AttemptsCount", "LastError", "LastAttemptAt", "CandidateEmailStatus", "RecruiterEmailStatus"]);
    pendingSheet.getRange("A1:I1").setFontWeight("bold").setBackground("#e2e8f0");
  }

  // 5. GradingTranscripts Sheet (per-answer rubric transcript log -- Phase 10)
  let transcriptsSheet = ss.getSheetByName("GradingTranscripts");
  if (!transcriptsSheet) {
    transcriptsSheet = ss.insertSheet("GradingTranscripts");
    transcriptsSheet.appendRow(["AttemptID", "QuestionID", "RubricVersion", "Verdict", "CriteriaMetJSON", "Rationale", "OverrideVerdict", "OverrideAt", "OverrideTokenHash"]);
    transcriptsSheet.getRange("A1:I1").setFontWeight("bold").setBackground("#e2e8f0");
  }
}

// --- EMAIL NORMALIZATION HELPER ---

function normalizeEmail(email) {
  if (!email) return "";
  let clean = email.trim().toLowerCase();
  
  // Gmail specific normalization
  if (clean.endsWith("@gmail.com")) {
    let parts = clean.split("@");
    let local = parts[0];
    
    // Remove plus addressing (e.g., user+test@gmail.com -> user@gmail.com)
    local = local.split("+")[0];
    
    // Remove dots (e.g., u.s.e.r@gmail.com -> user@gmail.com)
    local = local.replace(/\./g, "");
    
    clean = local + "@gmail.com";
  }
  
  return clean;
}

// --- ACTION HANDLERS ---

function handleStartAttempt(name, email) {
  if (!name || !email) {
    return { success: false, error: "Name and email are required" };
  }
  
  const normEmail = normalizeEmail(email);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const attemptsSheet = ss.getSheetByName("Attempts");
  const data = attemptsSheet.getDataRange().getValues();
  
  // Check duplicates
  for (let i = 1; i < data.length; i++) {
    const rowEmail = normalizeEmail(data[i][2]);
    const rowStatus = data[i][5];
    if (rowEmail === normEmail) {
      return { 
        success: false, 
        error: "An assessment attempt is already registered or completed for this email.", 
        isDuplicate: true 
      };
    }
  }
  
  // Assemble randomized frozen question set
  const assembledIds = assembleQuestionSet();
  const attemptId = "ATT-" + Utilities.getUuid().substring(0, 8).toUpperCase();
  const startTime = new Date();
  
  // Append new attempt
  attemptsSheet.appendRow([
    attemptId,
    name,
    email,
    startTime.toISOString(),
    "", // EndTime
    "active",
    JSON.stringify(assembledIds),
    "", "", "", "", 0, "", "" // Scores and insights empty for now
  ]);
  
  // Retrieve public question structures (no answer keys!)
  // SECURITY (Phase 10): This is an allowlist projection. Never add 'model_answer' or 'rubric' here — those fields ship grading logic and must remain server-side (see RESEARCH.md § Common Pitfalls — client-visible rubric leaks grading criteria).
  const clientQuestions = assembledIds.map(id => {
    const q = QUESTIONS.find(item => item.id === id);
    if (!q) return null;

    // Deep clone and strip is_correct from options
    // difficulty_tier is NOT answer-key material — safe to include; needed by Phase 4 level UI
    return {
      id: q.id,
      bank: q.bank,
      section: q.section,
      level: q.level,
      case_id: q.case_id,
      case_title: q.case_title,
      tabs: q.tabs,
      tables: q.tables,
      difficulty_tier: q.difficulty_tier || null, // NOT answer key — needed for Phase 4 level progress UI
      response_type: q.response_type,
      stem: q.stem,
      options: q.options.map(o => ({ letter: o.letter, text: o.text })) // omit is_correct!
    };
  }).filter(q => q !== null);
  
  return {
    success: true,
    attemptId: attemptId,
    startTime: startTime.toISOString(),
    questions: clientQuestions
  };
}

function handleCheckAttempt(attemptId) {
  if (!attemptId) return { active: false };
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const attemptsSheet = ss.getSheetByName("Attempts");
  const data = attemptsSheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === attemptId) {
      return {
        active: data[i][5] === "active",
        name: data[i][1],
        email: data[i][2],
        status: data[i][5]
      };
    }
  }
  
  return { active: false };
}

function handleLogIntegrity(attemptId, logType, details) {
  if (!attemptId || !logType) return { success: false, error: "Missing log details" };
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logsSheet = ss.getSheetByName("IntegrityLogs");
  const timestamp = new Date().toISOString();
  
  logsSheet.appendRow([attemptId, logType, JSON.stringify(details), timestamp]);
  
  // Update violation count in Attempts sheet
  const attemptsSheet = ss.getSheetByName("Attempts");
  const attemptsData = attemptsSheet.getDataRange().getValues();
  for (let i = 1; i < attemptsData.length; i++) {
    if (attemptsData[i][0] === attemptId) {
      let currentViolations = parseInt(attemptsData[i][11] || 0);
      attemptsSheet.getRange(i + 1, 12).setValue(currentViolations + 1);
      break;
    }
  }
  
  return { success: true };
}

function handleSubmitAnswers(attemptId, candidateAnswers) {
  if (!attemptId || !candidateAnswers) {
    return { success: false, error: "Missing attempt ID or answers" };
  }
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const attemptsSheet = ss.getSheetByName("Attempts");
  const attemptsData = attemptsSheet.getDataRange().getValues();
  
  let attemptRowIdx = -1;
  let attemptRow = null;
  
  for (let i = 1; i < attemptsData.length; i++) {
    if (attemptsData[i][0] === attemptId) {
      attemptRowIdx = i + 1;
      attemptRow = attemptsData[i];
      break;
    }
  }
  
  if (attemptRowIdx === -1) {
    return { success: false, error: "Attempt not found" };
  }
  
  if (attemptRow[5] !== "active") {
    return { success: false, error: "Attempt is already completed or inactive" };
  }

  const timestamp = new Date().toISOString();

  // Fast-enqueue: hand off to PendingGrading queue, drained asynchronously by AsyncGrading.gs
  ss.getSheetByName("PendingGrading").appendRow([
    attemptId,
    JSON.stringify(candidateAnswers),
    timestamp,
    "queued",
    0,
    "",
    "",
    "pending",
    "pending"
  ]);

  attemptsSheet.getRange(attemptRowIdx, 5, 1, 2).setValues([[timestamp, "pending_grading"]]); // E:F

  return { success: true, status: "pending_grading" };
}

function handleGetAttemptReport(attemptId, token) {
  if (!attemptId) return { success: false, error: "Missing attempt ID" };
  if (!checkAdminAuth(token)) return { success: false, error: "Unauthorized" };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const attemptsSheet = ss.getSheetByName("Attempts");
  const data = attemptsSheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === attemptId) {
      if (!READY_STATUSES.includes(data[i][5])) {
        return { success: false, error: "Report is not available yet" };
      }
      
      return {
        success: true,
        report: {
          attemptId:          data[i][0],
          name:               data[i][1],
          email:              data[i][2],
          overallScore:       data[i][7],
          traitScores: {
            language: data[i][8],
            research: data[i][9],
            critical: data[i][10]
          },
          recommendationTier: data[i][12],
          narrativeInsight:   data[i][13],
          violationCount:     data[i][11],
          ungradedCount:      Number(data[i][14]) || 0
        }
      };
    }
  }

  return { success: false, error: "Attempt not found" };
}

/**
 * Phase 10 (GRADE-08): recruiter-only GET returning per-answer rubric transcript rows
 * for a single attempt. Token-gated. Deliberately excludes OverrideTokenHash from the
 * response — the hash is an internal audit field, not something the UI needs to render.
 */
function handleGetAttemptTranscript(attemptId, token) {
  if (!attemptId) return { success: false, error: "Missing attempt ID" };
  if (!checkAdminAuth(token)) return { success: false, error: "Unauthorized" };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const transcriptsSheet = ss.getSheetByName("GradingTranscripts");
  if (!transcriptsSheet) return { success: true, transcript: [] };

  const data = transcriptsSheet.getDataRange().getValues();
  const transcript = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === attemptId) {
      transcript.push({
        questionId: data[i][1],
        rubricVersion: data[i][2],
        verdict: data[i][3],
        criteriaMet: JSON.parse(data[i][4] || "[]"),
        rationale: data[i][5] || "",
        overrideVerdict: data[i][6] || null,
        overrideAt: data[i][7] || null
      });
    }
  }
  return { success: true, transcript: transcript };
}

/**
 * Phase 10 (GRADE-09): recruiter-only POST that flips an LLM verdict for a single answer.
 *
 * Order of operations is load-bearing:
 *   1. Validate inputs before touching sheets
 *   2. checkAdminAuth OUTSIDE the lock (cheap failure returns fast without holding the lock)
 *   3. tryLock(10000ms) — longer than processGradingQueue's 5000ms so this yields to an in-flight drain
 *   4. SHA-256-hash the token (Utilities.computeDigest) — plaintext token is NEVER written to the sheet
 *   5. Overwrite OverrideVerdict / OverrideAt / OverrideTokenHash on the transcript row
 *   6. Re-aggregate all score columns via computeAggregatesForAttempt (in AsyncGrading.gs)
 *   7. Batch-write Attempts H:K + M:N + O — identical shape to gradeAndFinalizeAttempt
 *   8. releaseLock in finally
 *
 * newVerdict enum:  "correct" | "incorrect" | "null" (the "null" sentinel writes an EMPTY
 * OverrideVerdict, which effectiveVerdict() treats as "no override; fall through to Verdict"
 * — this is the A4 reversibility mechanism.)
 *
 * Deliberately no candidate email on override (A3 - see below): recruiter sees the updated
 * score in the admin panel via the returned report; candidate is not notified.
 */
function handleOverrideVerdict(attemptId, questionId, newVerdict, token) {
  if (!attemptId || !questionId) return { success: false, error: "Missing attempt or question ID" };
  if (!checkAdminAuth(token)) return { success: false, error: "Unauthorized" };
  const allowed = ["correct", "incorrect", "null"];
  if (!allowed.includes(newVerdict)) return { success: false, error: "Invalid verdict" };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { success: false, error: "Grading queue busy; try again in a moment." };

  try {
    // SHA-256 hex hash of the token (never store plaintext token in a sheet — T-10-03e mitigation)
    const tokenHashBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token, Utilities.Charset.UTF_8);
    const tokenHash = tokenHashBytes.map(function(b) { return ("0" + (b & 0xff).toString(16)).slice(-2); }).join("");
    const overrideAt = new Date().toISOString();

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const transcriptsSheet = ss.getSheetByName("GradingTranscripts");
    if (!transcriptsSheet) return { success: false, error: "GradingTranscripts sheet missing" };

    const data = transcriptsSheet.getDataRange().getValues();
    let rowIdx = -1;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === attemptId && data[i][1] === questionId) {
        rowIdx = i + 1;
        break;
      }
    }
    if (rowIdx === -1) return { success: false, error: "Transcript row not found for this question" };

    // A4 reversibility: newVerdict === "null" writes an empty override string
    const overrideCell = (newVerdict === "null") ? "" : newVerdict;
    transcriptsSheet.getRange(rowIdx, 7, 1, 3).setValues([[overrideCell, overrideAt, tokenHash]]);

    // Re-aggregate + batch-write Attempts (H:K + M:N + O) — same shape as plan 10-02 gradeAndFinalizeAttempt
    const agg = computeAggregatesForAttempt(attemptId, ss);
    const attemptsSheet = ss.getSheetByName("Attempts");
    const attemptsData = attemptsSheet.getDataRange().getValues();
    let attemptRowIdx = -1;
    for (let i = 1; i < attemptsData.length; i++) {
      if (attemptsData[i][0] === attemptId) { attemptRowIdx = i + 1; break; }
    }
    if (attemptRowIdx === -1) return { success: false, error: "Attempt row not found" };

    attemptsSheet.getRange(attemptRowIdx, 8, 1, 4).setValues([[agg.overallPercentage, agg.englishPct, agg.researchPct, agg.criticalPct]]); // H:K
    attemptsSheet.getRange(attemptRowIdx, 13, 1, 2).setValues([[agg.recommendationTier, agg.narrativeInsight]]); // M:N
    attemptsSheet.getRange(attemptRowIdx, 15).setValue(agg.ungradedCount); // O

    // A3: candidate is NOT emailed on override -- override is recruiter-visible only.
    return {
      success: true,
      report: buildReportFromAttemptsRow(attemptId),
      overrideAt: overrideAt
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Phase 10 (GRADE-10): recruiter-only POST that re-queues all ungraded answers for a
 * single attempt through evaluateWithRubric(). Reads original answers from Responses sheet,
 * re-grades via OpenRouter, updates GradingTranscripts, and re-aggregates Attempt scores.
 */
function handleRegradeAttempt(attemptId, token) {
  if (!attemptId) return { success: false, error: "Missing attempt ID" };
  if (!checkAdminAuth(token)) return { success: false, error: "Unauthorized" };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { success: false, error: "Grading queue busy; try again in a moment." };

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // 1. Read attempt's frozen question IDs
    const attemptsSheet = ss.getSheetByName("Attempts");
    if (!attemptsSheet) return { success: false, error: "Attempts sheet missing" };
    const attemptsData = attemptsSheet.getDataRange().getValues();
    let attemptRowIdx = -1;
    let frozenIds = [];
    for (let i = 1; i < attemptsData.length; i++) {
      if (attemptsData[i][0] === attemptId) {
        attemptRowIdx = i + 1;
        try { frozenIds = JSON.parse(attemptsData[i][6] || "[]"); } catch (e) { frozenIds = []; }
        break;
      }
    }
    if (attemptRowIdx === -1) return { success: false, error: "Attempt not found" };
    if (frozenIds.length === 0) return { success: false, error: "No frozen questions found for this attempt" };

    // 2. Read GradingTranscripts to find ungraded question IDs
    const transcriptsSheet = ss.getSheetByName("GradingTranscripts");
    if (!transcriptsSheet) return { success: false, error: "GradingTranscripts sheet missing" };
    const transcriptData = transcriptsSheet.getDataRange().getValues();
    const ungradedQIds = [];
    const transcriptRowMap = {}; // qId -> row index (1-based)
    for (let i = 1; i < transcriptData.length; i++) {
      if (transcriptData[i][0] === attemptId) {
        const qId = transcriptData[i][1];
        transcriptRowMap[qId] = i + 1;
        const verdict = transcriptData[i][3];
        const overrideVerdict = transcriptData[i][6];
        // Only re-grade if no override AND verdict is ungraded
        const effective = (overrideVerdict && overrideVerdict.length > 0) ? overrideVerdict : verdict;
        if (effective === "ungraded" || effective === "") {
          ungradedQIds.push(qId);
        }
      }
    }

    if (ungradedQIds.length === 0) {
      return { success: true, message: "No ungraded answers found — nothing to regrade.", regraded: 0 };
    }

    // 3. Read Responses sheet to get original answers
    const responsesSheet = ss.getSheetByName("Responses");
    if (!responsesSheet) return { success: false, error: "Responses sheet missing" };
    const responsesData = responsesSheet.getDataRange().getValues();
    const answerMap = {}; // qId -> submitted answer JSON
    for (let i = 1; i < responsesData.length; i++) {
      if (responsesData[i][0] === attemptId) {
        answerMap[responsesData[i][1]] = responsesData[i][2];
      }
    }

    // 4. Build grading requests for ungraded questions
    const gradingRequests = [];
    const questionsById = {};
    for (let q = 0; q < QUESTIONS.length; q++) {
      questionsById[QUESTIONS[q].id] = QUESTIONS[q];
    }
    for (let u = 0; u < ungradedQIds.length; u++) {
      const qId = ungradedQIds[u];
      const q = questionsById[qId];
      if (!q) continue;
      const answerRaw = answerMap[qId];
      if (answerRaw === undefined || answerRaw === null) continue;

      let answerText = "";
      try {
        const parsed = JSON.parse(answerRaw);
        if (typeof parsed === "object" && parsed !== null && "text" in parsed) {
          answerText = parsed.text || "";
        } else {
          answerText = String(parsed);
        }
      } catch (e) {
        answerText = String(answerRaw);
      }

      const prompt = "Question:\n" + (q.stem || "");
      gradingRequests.push({ qId: qId, prompt: prompt, answer: answerText });
    }

    if (gradingRequests.length === 0) {
      return { success: true, message: "No regradable answers found (missing question data or responses).", regraded: 0 };
    }

    // 5. Call evaluateWithRubric
    const results = evaluateWithRubric(gradingRequests, questionsById);

    // 6. Update GradingTranscripts rows
    const now = new Date().toISOString();
    let updatedCount = 0;
    for (const qId in results) {
      if (!transcriptRowMap[qId]) continue;
      const rowIdx = transcriptRowMap[qId];
      const r = results[qId];
      // Update verdict (col 4), criteriaMet (col 5), rationale (col 6)
      transcriptsSheet.getRange(rowIdx, 4, 1, 3).setValues([[
        r.verdict,
        JSON.stringify(r.criteriaMet || []),
        r.rationale || ""
      ]]);
      updatedCount++;
    }

    // 7. Re-aggregate scores
    const agg = computeAggregatesForAttempt(attemptId, ss);
    attemptsSheet.getRange(attemptRowIdx, 8, 1, 4).setValues([[agg.overallPercentage, agg.englishPct, agg.researchPct, agg.criticalPct]]);
    attemptsSheet.getRange(attemptRowIdx, 13, 1, 2).setValues([[agg.recommendationTier, agg.narrativeInsight]]);
    attemptsSheet.getRange(attemptRowIdx, 15).setValue(agg.ungradedCount);

    return {
      success: true,
      message: "Regrade complete. " + updatedCount + " answer(s) re-graded via LLM.",
      regraded: updatedCount,
      report: buildReportFromAttemptsRow(attemptId)
    };
  } finally {
    lock.releaseLock();
  }
}

function handleAdminListCandidates(token) {
  if (!checkAdminAuth(token)) return { success: false, error: "Unauthorized" };
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const attemptsSheet = ss.getSheetByName("Attempts");
  const data = attemptsSheet.getDataRange().getValues();
  const list = [];
  
  for (let i = 1; i < data.length; i++) {
    list.push({
      attemptId: data[i][0],
      name: data[i][1],
      email: data[i][2],
      startTime: data[i][3],
      endTime: data[i][4],
      status: data[i][5],
      overallScore: data[i][7],
      violationCount: data[i][11],
      recommendation: data[i][12],
      recommendationTier: data[i][12]
    });
  }
  
  return { success: true, list: list };
}

function handleAdminResetAttempt(email, token) {
  if (!checkAdminAuth(token)) return { success: false, error: "Unauthorized" };
  if (!email) return { success: false, error: "Missing email" };
  
  const normEmail = normalizeEmail(email);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const attemptsSheet = ss.getSheetByName("Attempts");
  const data = attemptsSheet.getDataRange().getValues();
  
  let deletedCount = 0;
  
  // We scan bottom-up to safely delete rows
  for (let i = data.length - 1; i >= 1; i--) {
    const rowEmail = normalizeEmail(data[i][2]);
    if (rowEmail === normEmail) {
      attemptsSheet.deleteRow(i + 1);
      deletedCount++;
    }
  }
  
  return { success: true, message: `Successfully reset ${deletedCount} attempt(s) for email ${email}` };
}

// --- SECURE TEST ASSEMBLY ENGINE ---

function assembleQuestionSet() {
  // Guard: fail loudly if the embedded question bank is empty
  // (indicates a re-deploy before Code.gs was synced with content/questions.json)
  if (!QUESTIONS || QUESTIONS.length === 0) {
    throw new Error("QUESTIONS bank is empty — re-deploy Code.gs with the embedded question data from ingestion/run.py sync");
  }

  // Deterministic fixed 24-question set (per "Changes required.docx").
  // Fixed order across 7 live zones numbered 1-6 then 8 (legacy numbering kept:
  // Zone 7 attention_l2 was removed, so there is no Zone 7; critical thinking = Zone 8).
  // 24 Qs = 30 marks (Zone 3 macro x2, Zone 5 closure x2).
  // Case mapping:
  // - att-level-1-q05+q07 = attn-l1-case-02 "THE REVIEW BEFORE CHECK-IN"
  // - att-level-1-q17+q19 = attn-l1-case-05 "THE NEGATIVE BUT VALID REVIEW"
  // - cri-risk-assessment-q13+q15 = ct-case-04 "Repeat Policy Violation Pattern"
  // - cri-risk-assessment-q21+q23 = ct-case-06 "Report Without Supporting Evidence"
  // - eng-reading q71+q72 = passage 1, q76 = passage 2 (3 Qs total)
  return [
    "eng-grammar-q02", "eng-grammar-q05", "eng-grammar-q06", "eng-grammar-q14",
    "eng-sentence-correction-q36", "eng-sentence-correction-q37", "eng-sentence-correction-q38",
    "eng-macro-q61", "eng-macro-q66", "eng-macro-q70",
    "eng-reading-q71", "eng-reading-q72", "eng-reading-q76",
    "eng-closure-q96", "eng-closure-q97", "eng-closure-q100",
    "att-level-1-q05", "att-level-1-q07", "att-level-1-q17", "att-level-1-q19",
    "cri-risk-assessment-q13", "cri-risk-assessment-q15", "cri-risk-assessment-q21", "cri-risk-assessment-q23"
  ];
}

// Helper: Group by property
function groupBy(xs, key) {
  return xs.reduce(function(rv, x) {
    (rv[x[key]] = rv[x[key]] || []).push(x);
    return rv;
  }, {});
}

// Helper: Random sampling without replacement
function sampleRandom(arr, count) {
  const shuffled = arr.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

// --- QUESTIONS DATABASE EMBEDDING ---

const QUESTIONS = [
  {
    "id": "eng-grammar-q01",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "The agent ___ the customer to provide additional evidence.",
    "options": [
      {
        "letter": "a",
        "text": "asking",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "asked",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "ask",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "was ask",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 1,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q02",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Each of the documents ___ carefully reviewed before the final decision.",
    "options": [
      {
        "letter": "a",
        "text": "were",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "are",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "was",
        "is_correct": true
      },
      {
        "letter": "d",
        "text": "be",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 2,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 2
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q03",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Every report ___ checked by a senior investigator.",
    "options": [
      {
        "letter": "a",
        "text": "are",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "were",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "is",
        "is_correct": true
      },
      {
        "letter": "d",
        "text": "have",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 3,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q04",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Neither the booking confirmation nor the screenshots ___ attached.",
    "options": [
      {
        "letter": "a",
        "text": "are",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "were",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "was",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "have",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 4,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q05",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "The investigation team ___ responsible for reviewing reported listings.",
    "options": [
      {
        "letter": "a",
        "text": "are",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "is",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "were",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "have",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 5,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 5
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q06",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "The traveler ___ the requested documents yesterday.",
    "options": [
      {
        "letter": "a",
        "text": "send",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "sent",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "sending",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "sends",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 6,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 6
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q07",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "We ___ for the customer's response since Monday.",
    "options": [
      {
        "letter": "a",
        "text": "wait",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "waited",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "have been waiting",
        "is_correct": true
      },
      {
        "letter": "d",
        "text": "waiting",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 7,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 7
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q08",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "The customer ___ the booking confirmation before contacting support.",
    "options": [
      {
        "letter": "a",
        "text": "uploads",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "uploaded",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "uploading",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "upload",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 8,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 8
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q09",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "While the agent ___ the evidence, the customer updated the case.",
    "options": [
      {
        "letter": "a",
        "text": "checked",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "checks",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "was checking",
        "is_correct": true
      },
      {
        "letter": "d",
        "text": "has checked",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 9,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 9
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q10",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "The support team ___ your appeal by tomorrow.",
    "options": [
      {
        "letter": "a",
        "text": "review",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "reviewed",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "will review",
        "is_correct": true
      },
      {
        "letter": "d",
        "text": "reviewing",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 10,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 10
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q11",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "The review ___ after the investigation was completed.",
    "options": [
      {
        "letter": "a",
        "text": "removed",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "was removed",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "remove",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "removing",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 11,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 11
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q12",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "The documents ___ by the Fraud Support team yesterday.",
    "options": [
      {
        "letter": "a",
        "text": "reviewed",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "review",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "were reviewed",
        "is_correct": true
      },
      {
        "letter": "d",
        "text": "reviewing",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 12,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 12
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q13",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Your request ___ by our team within 48 hours.",
    "options": [
      {
        "letter": "a",
        "text": "will be reviewed",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "reviews",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "reviewing",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "review",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 13,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 13
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q14",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "The account ___ due to suspicious activity.",
    "options": [
      {
        "letter": "a",
        "text": "suspended",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "was suspended",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "suspend",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "suspending",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 14,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 14
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q15",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "All evidence ___ before making a final decision.",
    "options": [
      {
        "letter": "a",
        "text": "should review",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "should be reviewed",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "should reviewed",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "reviewing",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 15,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 15
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q16",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Please provide ___ update on the status of your request.",
    "options": [
      {
        "letter": "a",
        "text": "a",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "an",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "many",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "no article",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 16,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 16
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q17",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "The investigation is still ___ progress.",
    "options": [
      {
        "letter": "a",
        "text": "on",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "at",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "in",
        "is_correct": true
      },
      {
        "letter": "d",
        "text": "into",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 17,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 17
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q18",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "The customer replied ___ our email yesterday.",
    "options": [
      {
        "letter": "a",
        "text": "to",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "with",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "on",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "for",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 18,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 18
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q19",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "The review was removed ___ violating platform guidelines.",
    "options": [
      {
        "letter": "a",
        "text": "because",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "because of",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "due",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "despite",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 19,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 19
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q20",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Please submit the requested documents ___ Friday.",
    "options": [
      {
        "letter": "a",
        "text": "in",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "by",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "on",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "into",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 20,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 20
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q21",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "We cannot proceed until the customer ___ the missing information.",
    "options": [
      {
        "letter": "a",
        "text": "provide",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "provides",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "provided",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "providing",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 21,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 21
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q22",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "The evidence appears ___ to support the claim.",
    "options": [
      {
        "letter": "a",
        "text": "sufficient",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "sufficiently",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "suffice",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "sufficiency",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 22,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 22
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q23",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Kindly ___ the attachment once again.",
    "options": [
      {
        "letter": "a",
        "text": "send",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "sends",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "sending",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "sent",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 23,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 23
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q24",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "The reviewer ___ not respond to our previous request.",
    "options": [
      {
        "letter": "a",
        "text": "did",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "does",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "has",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "do",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 24,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 24
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q25",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "The investigation cannot continue unless additional evidence ___.",
    "options": [
      {
        "letter": "a",
        "text": "provide",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "provides",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "is provided",
        "is_correct": true
      },
      {
        "letter": "d",
        "text": "provided",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 25,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 25
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q26",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "The review appears to ___ genuine based on the available evidence.",
    "options": [
      {
        "letter": "a",
        "text": "being",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "be",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "been",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "is",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 26,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 26
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q27",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "If the customer had submitted clearer images, the verification ___ completed earlier.",
    "options": [
      {
        "letter": "a",
        "text": "could have been",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "can be",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "could be",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "is",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 27,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 27
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q28",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "The listing ___ removed if it violates our policies, subject to review.",
    "options": [
      {
        "letter": "a",
        "text": "may be",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "may being",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "maybe",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "may been",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 28,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 28
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q29",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "The reviewer claimed they ___ at the property for three nights last June.",
    "options": [
      {
        "letter": "a",
        "text": "stay",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "stayed",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "staying",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "stays",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 29,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 29
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-grammar-q30",
    "bank": "english",
    "section": "grammar",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "mcq_single",
    "stem": "After reviewing the evidence, the agent decided ___ the case.",
    "options": [
      {
        "letter": "a",
        "text": "closing",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "close",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "to close",
        "is_correct": true
      },
      {
        "letter": "d",
        "text": "closed",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 30,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 1 - Grammar MCQs",
      "number": 30
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q31",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Customer didn’t sent the screenshot so we can’t verify nothing.",
    "options": [],
    "model_answer": "The customer did not send the screenshot, so we are unable to verify the information.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Corrects 'didn't sent' to 'didn't send' (base form after did); resolves double negative 'can't verify nothing' to 'can't verify anything' or 'can verify nothing'; proper punctuation and spelling" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains original meaning: customer failed to send screenshot, verification is impossible" },
      { name: "Professional Tone", weight: 0.2, description: "Formal register for case note; contractions replaced with full forms; professional phrasing" }
    ] },

    "position": 31,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q32",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "This case is solve kindly check your account again.",
    "options": [],
    "model_answer": "This case has been resolved. Kindly check your account again.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Corrects 'is solve' to 'has been resolved' or 'is solved'; fixes missing subject-verb agreement; proper punctuation" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains original meaning: case is resolved, customer should check their account" },
      { name: "Professional Tone", weight: 0.2, description: "Polite, professional register; 'kindly' acceptable in customer-facing context; formal phrasing" }
    ] },

    "position": 32,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 2
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q33",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Agent not able to open the link because it was expired.",
    "options": [],
    "model_answer": "The agent was unable to open the link because it had expired.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Adds missing auxiliary 'was' before 'not able'; corrects 'was expired' to 'had expired' (intransitive verb not used in passive); adds article 'The' before 'Agent'" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: agent could not access link due to expiration" },
      { name: "Professional Tone", weight: 0.2, description: "Formal register; avoids contractions; professional tone" }
    ] },

    "position": 33,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q34",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "We are following up from two days but you not respond yet.",
    "options": [],
    "model_answer": "We have been following up for the past two days, but we have not yet received your response.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Changes to present perfect continuous 'have been following up for two days'; corrects 'you not respond' to 'you have not responded'; fixes preposition 'from' to 'for'" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: repeated follow-ups over two days without response" },
      { name: "Professional Tone", weight: 0.2, description: "Professional tone; avoids blaming language; formal register" }
    ] },

    "position": 34,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q35",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Kindly share the details fastly so we done the verification.",
    "options": [],
    "model_answer": "Kindly share the requested details as soon as possible so that we can complete the verification.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Replaces nonstandard 'fastly' with 'as soon as possible' or 'promptly'; corrects 'we done' to 'we can complete' (wrong verb form and missing modal)" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: request for details to complete verification" },
      { name: "Professional Tone", weight: 0.2, description: "Polite request; professional customer service register" }
    ] },

    "position": 35,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 5
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q36",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "The property owner say the review is fake.",
    "options": [],
    "model_answer": "The property owner stated that the review is fake.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 1.0, description: "Corrects the subject-verb agreement error 'owner say' with an appropriate, grammatically correct reporting verb (e.g., 'states,' 'stated,' 'claims,' 'claimed,' 'says,' or 'said'). If the corrected response makes sense, award full credit." }
    ] },

    "position": 36,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 6
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q37",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "We didn't received enough evidences.",
    "options": [],
    "model_answer": "We did not receive sufficient evidence to proceed with the investigation.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 1.0, description: "Corrects 'didn't received' to 'did not receive' (base form after did) and uncountable 'evidences' to 'evidence'. If the corrected response makes sense, award full credit." }
    ] },

    "position": 37,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 7
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q38",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Please send us your booking ID for verify your stay.",
    "options": [],
    "model_answer": "Please provide your booking ID so that we can verify your stay.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 1.0, description: "Corrects 'for verify' to 'so that we can verify' or 'to verify' (infinitive of purpose or subordinate clause required). If the corrected response makes sense, award full credit." }
    ] },

    "position": 38,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 8
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q39",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Your request already forwarded to our specialist team.",
    "options": [],
    "model_answer": "Your request has already been forwarded to our specialist team.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Adds missing passive auxiliary 'has been' ('Your request has already been forwarded'); ensures correct present perfect passive construction" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: request has been passed to specialists" },
      { name: "Professional Tone", weight: 0.2, description: "Formal, reassuring tone" }
    ] },

    "position": 39,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 9
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q40",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "We appreciate your patient during investigation.",
    "options": [],
    "model_answer": "We appreciate your patience during the investigation.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Corrects 'patient' (adjective) to 'patience' (noun); adds article 'the' before 'investigation'" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: gratitude for customer's patience during process" },
      { name: "Professional Tone", weight: 0.2, description: "Warm, professional tone expressing appreciation" }
    ] },

    "position": 40,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 10
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q41",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Review has removed because violate our guideline.",
    "options": [],
    "model_answer": "The review has been removed because it violated our guidelines.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Adds article 'The' before 'Review'; corrects 'has removed' to 'has been removed' (passive voice needed); corrects 'violate' to 'violated' (past tense) with subject 'it'; pluralizes 'guideline' to 'guidelines'" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: review removed for policy violation" },
      { name: "Professional Tone", weight: 0.2, description: "Formal, factual tone; avoids emotional language" }
    ] },

    "position": 41,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 11
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q42",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Customer not provide insufficient evidence to continue investigation.",
    "options": [],
    "model_answer": "The customer has not provided sufficient evidence to continue the investigation.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Adds article 'The' before 'Customer'; corrects 'not provide' to 'has not provided'; resolves double negative 'not provide insufficient' to 'has not provided sufficient'; adds article 'the' before 'investigation'" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: customer has not supplied enough evidence" },
      { name: "Professional Tone", weight: 0.2, description: "Neutral, factual tone" }
    ] },

    "position": 42,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 12
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q43",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Please upload the document again because image are blurry.",
    "options": [],
    "model_answer": "Please upload the document again because the images are blurry.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Corrects 'image' to 'images' (plural to match 'are'); adds article 'the' before 'images'" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: images unclear, re-upload needed" },
      { name: "Professional Tone", weight: 0.2, description: "Polite request; clear instruction" }
    ] },

    "position": 43,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 13
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q44",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "We can't process this request until documents is received.",
    "options": [],
    "model_answer": "We cannot process this request until the required documents are received.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Corrects 'documents is' to 'documents are' (subject-verb agreement); adds article 'the required' before 'documents'" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: request blocked pending document receipt" },
      { name: "Professional Tone", weight: 0.2, description: "Formal, clear tone" }
    ] },

    "position": 44,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 14
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q45",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Kindly wait while we investigate your issue and update you soonest.",
    "options": [],
    "model_answer": "Kindly wait while we investigate your issue. We will update you as soon as possible.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Replaces nonstandard 'soonest' with 'as soon as possible'; adds sentence boundary or conjunction for clarity between clauses" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: investigation in progress, update forthcoming" },
      { name: "Professional Tone", weight: 0.2, description: "Polite, reassuring tone" }
    ] },

    "position": 45,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 15
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q46",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Your appeal was rejected because there have no enough evidence.",
    "options": [],
    "model_answer": "Your appeal was rejected because there was insufficient evidence to support your request.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Corrects 'there have no enough' to 'there was insufficient' or 'there was not enough' (wrong existential construction and adjective form)" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: appeal rejected due to insufficient evidence" },
      { name: "Professional Tone", weight: 0.2, description: "Formal, empathetic tone" }
    ] },

    "position": 46,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 16
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q47",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Please contact us back if you have any doubt.",
    "options": [],
    "model_answer": "Please contact us if you have any further questions.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Removes redundant 'back' from 'contact us back'; replaces 'doubt' with 'further questions' or 'concerns' for clarity" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: invitation to follow up if needed" },
      { name: "Professional Tone", weight: 0.2, description: "Friendly, open tone; customer-service appropriate" }
    ] },

    "position": 47,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 17
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q48",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Investigation still in progress kindly don't create multiple tickets.",
    "options": [],
    "model_answer": "The investigation is still in progress. Kindly avoid creating multiple tickets, as this may delay the review process.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Adds article 'The' before 'Investigation'; adds missing verb 'is'; adds punctuation between clauses; replaces 'don't create' with 'kindly avoid creating'" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: case being worked, avoid duplicate tickets" },
      { name: "Professional Tone", weight: 0.2, description: "Polite instruction; professional tone" }
    ] },

    "position": 48,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 18
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q49",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "The customer uploaded wrong attachment two time.",
    "options": [],
    "model_answer": "The customer uploaded the wrong attachment twice.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Adds article 'the' before 'wrong attachment'; corrects 'two time' to 'twice' or 'two times'" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: customer submitted incorrect file multiple times" },
      { name: "Professional Tone", weight: 0.2, description: "Factual, neutral tone" }
    ] },

    "position": 49,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 19
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q50",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "We are unable verify your booking because booking details missing.",
    "options": [],
    "model_answer": "We are unable to verify your booking because the booking details are missing.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Adds 'to' after 'unable' ('unable to verify'); adds article 'the' before 'booking details'; adds missing verb 'are' ('details are missing')" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: verification blocked due to missing details" },
      { name: "Professional Tone", weight: 0.2, description: "Formal, clear tone" }
    ] },

    "position": 50,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 20
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q51",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "The customer send the booking confirmation yesterday.",
    "options": [],
    "model_answer": "The customer sent the booking confirmation yesterday.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Corrects 'send' to 'sent' (past tense required by 'yesterday')" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: customer submitted confirmation on a previous day" },
      { name: "Professional Tone", weight: 0.2, description: "Factual report tone" }
    ] },

    "position": 51,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 21
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q52",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "We has reviewed the evidence provided by the traveler.",
    "options": [],
    "model_answer": "We have reviewed the evidence provided by the traveler.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Corrects 'has' to 'have' (subject-verb agreement with 'We')" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: evidence has been reviewed" },
      { name: "Professional Tone", weight: 0.2, description: "Formal, factual tone" }
    ] },

    "position": 52,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 22
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q53",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "The investigation are currently in progress.",
    "options": [],
    "model_answer": "The investigation is currently in progress.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Corrects 'are' to 'is' (subject-verb agreement with singular 'investigation')" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: case is ongoing" },
      { name: "Professional Tone", weight: 0.2, description: "Formal status update tone" }
    ] },

    "position": 53,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 23
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q54",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "The property owner didn't provided enough evidence.",
    "options": [],
    "model_answer": "The property owner did not provide sufficient evidence.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Corrects 'didn't provided' to 'did not provide' (base form required after 'did')" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: owner's evidence was insufficient" },
      { name: "Professional Tone", weight: 0.2, description: "Neutral, factual tone" }
    ] },

    "position": 54,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 24
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q55",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Customer have uploaded the wrong attachment.",
    "options": [],
    "model_answer": "The customer has uploaded the wrong attachment.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Corrects 'have' to 'has' (subject-verb agreement with singular 'Customer'); adds article 'The' before 'Customer'" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: incorrect file was submitted" },
      { name: "Professional Tone", weight: 0.2, description: "Factual report tone" }
    ] },

    "position": 55,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 25
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q56",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Please ensure all document is attached before submitting your appeal.",
    "options": [],
    "model_answer": "Please ensure all documents are attached before submitting your appeal.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Corrects 'all document' to 'all documents' (plural required); corrects 'is' to 'are' (subject-verb agreement with plural)" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: all files must be attached prior to submission" },
      { name: "Professional Tone", weight: 0.2, description: "Clear instruction; professional tone" }
    ] },

    "position": 56,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 26
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q57",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "The review were removed because it violate our guidelines.",
    "options": [],
    "model_answer": "The review was removed because it violated our guidelines.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Corrects 'were' to 'was' (subject-verb agreement with singular 'review'); corrects 'violate' to 'violated' (past tense)" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: review removed for guideline violation" },
      { name: "Professional Tone", weight: 0.2, description: "Formal, factual tone" }
    ] },

    "position": 57,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 27
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q58",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "We appreciate your patient while we investigate the issue.",
    "options": [],
    "model_answer": "We appreciate your patience while we investigate the issue.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Corrects 'patient' (adjective) to 'patience' (noun needed as object of 'appreciate')" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: gratitude for patience during investigation" },
      { name: "Professional Tone", weight: 0.2, description: "Warm, appreciative tone" }
    ] },

    "position": 58,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 28
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q59",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Kindly provide more informations regarding your booking.",
    "options": [],
    "model_answer": "Kindly provide more information regarding your booking.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Corrects uncountable noun error 'informations' to 'information' (no plural form); ensures subject-verb agreement" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: request for additional booking details" },
      { name: "Professional Tone", weight: 0.2, description: "Polite request; professional tone" }
    ] },

    "position": 59,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 29
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-sentence-correction-q60",
    "bank": "english",
    "section": "sentence_correction",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "The agent was unable access the attachment.",
    "options": [],
    "model_answer": "The agent was unable to access the attachment.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.5, description: "Adds missing infinitive marker 'to' after 'unable' ('unable to access')" },
      { name: "Meaning Preservation", weight: 0.3, description: "Retains meaning: agent could not open the attachment" },
      { name: "Professional Tone", weight: 0.2, description: "Formal, factual tone" }
    ] },

    "position": 60,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "Part 2: Sentence Correction",
      "number": 30
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "eng-macro-q61",
    "bank": "english",
    "section": "macro",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Customer Scenario:\nA property owner is upset because a guest who never stayed at the property left a negative review. The review discusses the booking and check-in experience.\n\nExisting Macro:\nHello {{ticket.requester.first_name}},\nThanks for contact us. Your case is handle by our specialist team who checking integrity issue. They will review and make final decision.\nThank you for understand.\n{{ticket.assignee.signature}}\nContent Integrity Team",
    "options": [],
    "model_answer": "Hello {{ticket.requester.first_name}},\nThank you for contacting us.\nWe understand your concern regarding the review. After reviewing the information provided, we found that reviews discussing booking or check-in experiences may be allowed under our guidelines.\nIf you would like to share your perspective, we encourage you to post a management response to the review.\nThank you for your understanding.\n{{ticket.assignee.signature}}\nContent Integrity Team",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 1.0, description: "The rewritten macro must be grammatically correct with proper punctuation and register, no informal contractions, and appropriate formal salutation and sign-off. If the corrected response makes sense, award full credit." }
    ] },

    "position": 61,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 3: MACRO EDITING & PERSONALIZATION",
      "number": 1
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-macro-q62",
    "bank": "english",
    "section": "macro",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Customer Scenario:\nA traveler reports a review they believe is fake. After investigation, no policy violations were identified.\n\nExisting Macro:\nHi,\nWe not receive enough proof for continue investigation. Kindly send documents soon.\nRegards.",
    "options": [],
    "model_answer": "Hello,\nThank you for contacting us.\nWe understand your concern regarding the review. After carefully assessing the available information, we did not identify any violations of our review guidelines. As a result, the review will remain published.\nThank you for your understanding.\nRegards,\nContent Integrity Team",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.3, description: "Grammatically correct; proper punctuation and spelling; appropriate register for customer-facing email" },
      { name: "Professional Tone", weight: 0.3, description: "Empathetic but firm; explains outcome without being dismissive; maintains professional distance from the traveler's frustration" },
      { name: "Instruction Adherence", weight: 0.4, description: "Clearly states no policy violations were identified after investigation; confirms the review will remain published; explains the investigation outcome" }
    ] },

    "position": 62,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 3: MACRO EDITING & PERSONALIZATION",
      "number": 2
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-macro-q63",
    "bank": "english",
    "section": "macro",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Customer Scenario:\nA property owner reports multiple suspicious reviews. The investigation is still in progress.\n\nExisting Macro:\nHello,\nYour review already removed because violate guideline.\nThanks.",
    "options": [],
    "model_answer": "Hello,\nThank you for contacting us.\nWe appreciate you reporting your concerns. Our specialist team is currently investigating the reviews you reported. At this time, the investigation is still in progress, and no final decision has been made.\nWe will update you once the review is complete.\nThank you for your patience.\nContent Integrity Team",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.3, description: "Grammatically correct; proper punctuation and sentence structure throughout" },
      { name: "Professional Tone", weight: 0.3, description: "Reassuring tone; acknowledges the owner's report of multiple suspicious reviews; sets appropriate timeline expectations" },
      { name: "Instruction Adherence", weight: 0.4, description: "Confirms investigation is currently in progress; does not claim the review was already removed (correcting the broken macro); promises to update once review is complete" }
    ] },

    "position": 63,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 3: MACRO EDITING & PERSONALIZATION",
      "number": 3
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-macro-q64",
    "bank": "english",
    "section": "macro",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Customer Scenario:\nA traveler submitted blurry ID documents. Additional verification is required.\n\nExisting Macro:\nHello,\nPlease don't send many ticket because delay investigation.\nThanks.",
    "options": [],
    "model_answer": "Hello,\nThank you for contacting us.\nWe reviewed the documents you submitted; however, they are not clear enough for verification. Kindly upload clear and readable copies of your ID so we can continue reviewing your case.\nThank you for your cooperation.\nContent Integrity Team",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.3, description: "Grammatically correct; clear sentence structure; appropriate register for customer email" },
      { name: "Professional Tone", weight: 0.3, description: "Polite and helpful; explains the document issue without blaming the traveler; provides a clear call to action" },
      { name: "Instruction Adherence", weight: 0.4, description: "Explains that submitted ID documents were unclear; requests clear and readable copies; specifies what is needed to continue verification" }
    ] },

    "position": 64,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 3: MACRO EDITING & PERSONALIZATION",
      "number": 4
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-macro-q65",
    "bank": "english",
    "section": "macro",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Customer Scenario:\nA property owner appealed a review removal decision. After re-investigation, the original decision remains unchanged.\n\nExisting Macro:\nHi,\nCase still pending because documents not clear.\nRegards.",
    "options": [],
    "model_answer": "Hello,\nThank you for contacting us.\nWe appreciate you submitting an appeal. After carefully reviewing your case again, we have determined that the original decision remains unchanged based on our review guidelines.\nThank you for your understanding.\nRegards,\nContent Integrity Team",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.3, description: "Grammatically correct; proper punctuation and spelling throughout" },
      { name: "Professional Tone", weight: 0.3, description: "Respectful of the appeal process; firm but empathetic in communicating the unchanged decision; acknowledges the owner's effort" },
      { name: "Instruction Adherence", weight: 0.4, description: "States the appeal was carefully reviewed; confirms the original decision remains unchanged; references review guidelines; does not promise future reversal" }
    ] },

    "position": 65,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 3: MACRO EDITING & PERSONALIZATION",
      "number": 5
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-macro-q66",
    "bank": "english",
    "section": "macro",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Customer Scenario:\nA traveler has already submitted all the requested documents and is asking for an update on their case.\n\nExisting Macro:\nHello,\nPlease upload your booking confirmation and ID proof so we can start investigation. If not receive in 48 hours case will closed.\nThanks.",
    "options": [],
    "model_answer": "Hello,\nThank you for contacting us.\nWe have received the documents you submitted. Your case is currently under review by our specialist team, and we will notify you once the investigation has been completed.\nThank you for your patience.\nContent Integrity Team",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 1.0, description: "The rewritten macro must be grammatically correct with appropriate sentence structure and punctuation. If the corrected response makes sense, award full credit." }
    ] },

    "position": 66,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 3: MACRO EDITING & PERSONALIZATION",
      "number": 6
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-macro-q67",
    "bank": "english",
    "section": "macro",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Customer Scenario:\nA customer accidentally uploaded the wrong booking confirmation and wants to know what to do next.\n\nExisting Macro:\nHi,\nYour booking has verified successfully. No further action require.\nRegards.",
    "options": [],
    "model_answer": "Hello,\nThank you for contacting us.\nWe noticed that the incorrect booking confirmation was uploaded. Kindly submit the correct booking confirmation so that we can verify your booking and continue reviewing your request.\nThank you for your cooperation.\nRegards,\nContent Integrity Team",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.3, description: "Grammatically correct; proper punctuation throughout" },
      { name: "Professional Tone", weight: 0.3, description: "Helpful and clear; identifies the wrong-document issue without assigning blame to the customer" },
      { name: "Instruction Adherence", weight: 0.4, description: "Notes that an incorrect document was uploaded; requests the correct booking confirmation; explains what is needed to proceed with verification" }
    ] },

    "position": 67,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 3: MACRO EDITING & PERSONALIZATION",
      "number": 7
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-macro-q68",
    "bank": "english",
    "section": "macro",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Customer Scenario:\nA property owner submitted an appeal, and the case has been escalated to the specialist team for further review.\n\nExisting Macro:\nHello,\nWe completed investigation and your appeal rejected permanently. This decision cannot change.\nThank you.",
    "options": [],
    "model_answer": "Hello,\nThank you for contacting us.\nYour appeal has been escalated to our specialist team for further review. They will carefully assess the available information before making a final decision.\nWe will update you once the review has been completed.\nThank you for your patience.\nContent Integrity Team",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.3, description: "Grammatically correct; professional sentence structure and punctuation" },
      { name: "Professional Tone", weight: 0.3, description: "Reassuring tone; acknowledges the escalation to specialist team; sets appropriate expectations for timeline" },
      { name: "Instruction Adherence", weight: 0.4, description: "Confirms the appeal has been escalated to the specialist team; does not incorrectly claim rejection (correcting the broken macro); promises update once the review is complete" }
    ] },

    "position": 68,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 3: MACRO EDITING & PERSONALIZATION",
      "number": 8
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-macro-q69",
    "bank": "english",
    "section": "macro",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Customer Scenario:\nA traveler contacted support because their review was removed for violating the review guidelines.\n\nExisting Macro:\nHi,\nYour review restored successfully. Thank you for waiting.\nRegards.",
    "options": [],
    "model_answer": "Hello,\nThank you for contacting us.\nAfter reviewing your appeal, we confirmed that your review was removed because it did not comply with our review guidelines. Therefore, the original decision remains unchanged.\nThank you for your understanding.\nRegards,\nContent Integrity Team",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.3, description: "Grammatically correct; proper punctuation and register throughout" },
      { name: "Professional Tone", weight: 0.3, description: "Empathetic but firm; does not celebrate or cheerfully announce the review removal; maintains professionalism" },
      { name: "Instruction Adherence", weight: 0.4, description: "Confirms the review was removed because it did not comply with guidelines; does not incorrectly claim restoration (correcting the broken macro); explains the decision stands after appeal review" }
    ] },

    "position": 69,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 3: MACRO EDITING & PERSONALIZATION",
      "number": 9
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-macro-q70",
    "bank": "english",
    "section": "macro",
    "level": null,
    "case_id": null,
    "case_title": null,
    "tabs": null,
    "tables": null,
    "response_type": "open_text",
    "stem": "Customer Scenario:\nA property owner has not provided sufficient evidence to support their report. The investigation cannot proceed until the required information is received.\n\nExisting Macro:\nHello,\nWe found policy violation and removed review already. Thank you for reporting.\nRegards.",
    "options": [],
    "model_answer": "Hello,\nThank you for contacting us.\nAt this time, we do not have sufficient information to continue our investigation. Kindly provide the requested supporting evidence so that we can review your report further.\nThank you for your cooperation.\nRegards,\nContent Integrity Team",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 1.0, description: "The rewritten macro must be grammatically correct with proper punctuation and register. If the corrected response makes sense, award full credit." }
    ] },

    "position": 70,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 3: MACRO EDITING & PERSONALIZATION",
      "number": 10
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q71",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-1",
    "case_title": "Passage 1 – Review Authenticity Complaint",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello Support Team,\nI noticed that a review posted on my property page is unfair, and I believe it is fake. The reviewer gave us a one-star rating and mentioned poor service. However, I cannot find any record of this person staying at my property. Please investigate and remove the review if it does not meet your guidelines.\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Can it be concluded from the message that the review is fake?",
    "options": [
      {
        "letter": "a",
        "text": "Yes",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "No",
        "is_correct": true
      }
    ],
    "model_answer": null,
    "position": 71,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 1
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q72",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-1",
    "case_title": "Passage 1 – Review Authenticity Complaint",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello Support Team,\nI noticed that a review posted on my property page is unfair, and I believe it is fake. The reviewer gave us a one-star rating and mentioned poor service. However, I cannot find any record of this person staying at my property. Please investigate and remove the review if it does not meet your guidelines.\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Why did the property owner contact support?",
    "options": [
      {
        "letter": "a",
        "text": "To request a refund",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "To update property information",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "To report a potentially fake review",
        "is_correct": true
      },
      {
        "letter": "d",
        "text": "To change the property's rating",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 72,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 2
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q73",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-1",
    "case_title": "Passage 1 – Review Authenticity Complaint",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello Support Team,\nI noticed that a review posted on my property page is unfair, and I believe it is fake. The reviewer gave us a one-star rating and mentioned poor service. However, I cannot find any record of this person staying at my property. Please investigate and remove the review if it does not meet your guidelines.\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which information would be most important to verify first?",
    "options": [
      {
        "letter": "a",
        "text": "Whether the reviewer has a valid connection to the property",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "Whether the property owner replied publicly",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "Whether the review received one star",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "Whether similar reviews exist",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 73,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 3
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q74",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-1",
    "case_title": "Passage 1 – Review Authenticity Complaint",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello Support Team,\nI noticed that a review posted on my property page is unfair, and I believe it is fake. The reviewer gave us a one-star rating and mentioned poor service. However, I cannot find any record of this person staying at my property. Please investigate and remove the review if it does not meet your guidelines.\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the most appropriate next step?",
    "options": [
      {
        "letter": "a",
        "text": "Remove the review immediately",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "Investigate the available evidence before making a decision",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "Suspend the reviewer",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "Close the report",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 74,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 4
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q75",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-1",
    "case_title": "Passage 1 – Review Authenticity Complaint",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello Support Team,\nI noticed that a review posted on my property page is unfair, and I believe it is fake. The reviewer gave us a one-star rating and mentioned poor service. However, I cannot find any record of this person staying at my property. Please investigate and remove the review if it does not meet your guidelines.\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "(Select ALL that apply.) Which statements are supported by the customer's message?",
    "options": [
      {
        "letter": "a",
        "text": "The reviewer left a one-star rating.",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "The property owner cannot find a stay record.",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "The review has already been removed.",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "The property owner requested an investigation.",
        "is_correct": true
      }
    ],
    "model_answer": null,
    "position": 75,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 5
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "eng-reading-q76",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-2",
    "case_title": "Passage 2 – Property Listing Concern",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello,\nI booked a Standard Room because the property's listing mentioned beautiful ocean views. When I arrived, my room overlooked the parking area instead. I feel the listing was misleading because I expected an ocean-view room.\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which information should the agent review first?",
    "options": [
      {
        "letter": "a",
        "text": "Customer review history",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "Room category booked and the property's listing description",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "Hotel rating",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "Cancellation policy",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 76,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 1
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q77",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-2",
    "case_title": "Passage 2 – Property Listing Concern",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello,\nI booked a Standard Room because the property's listing mentioned beautiful ocean views. When I arrived, my room overlooked the parking area instead. I feel the listing was misleading because I expected an ocean-view room.\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "(Select ALL that apply.) Which information would help determine whether the listing was misleading?",
    "options": [
      {
        "letter": "a",
        "text": "The room category booked.",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "The property's room descriptions.",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "Whether the customer purchased an upgraded room.",
        "is_correct": true
      },
      {
        "letter": "d",
        "text": "The customer's previous stays at the property.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 77,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "eng-reading-q78",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-2",
    "case_title": "Passage 2 – Property Listing Concern",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello,\nI booked a Standard Room because the property's listing mentioned beautiful ocean views. When I arrived, my room overlooked the parking area instead. I feel the listing was misleading because I expected an ocean-view room.\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the customer's primary concern?",
    "options": [
      {
        "letter": "a",
        "text": "The booking was cancelled.",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "The room did not match the customer's expectation.",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "The room was unclean.",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "The hotel charged the customer twice.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 78,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 3
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q79",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-2",
    "case_title": "Passage 2 – Property Listing Concern",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello,\nI booked a Standard Room because the property's listing mentioned beautiful ocean views. When I arrived, my room overlooked the parking area instead. I feel the listing was misleading because I expected an ocean-view room.\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Does the customer's complaint alone prove that the listing is misleading?",
    "options": [
      {
        "letter": "a",
        "text": "Yes",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "No",
        "is_correct": true
      }
    ],
    "model_answer": null,
    "position": 79,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 4
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q80",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-2",
    "case_title": "Passage 2 – Property Listing Concern",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello,\nI booked a Standard Room because the property's listing mentioned beautiful ocean views. When I arrived, my room overlooked the parking area instead. I feel the listing was misleading because I expected an ocean-view room.\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is supported by the passage?",
    "options": [
      {
        "letter": "a",
        "text": "Every room at the property has an ocean view.",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "The customer booked a Standard Room.",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "The hotel admitted the listing was incorrect.",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "The customer received compensation.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 80,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 5
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q81",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-3",
    "case_title": "Passage 3 – Account Verification Request",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello,\nI submitted my verification documents yesterday, but I received another message asking me to upload them again. I believe the documents I submitted are correct. Could you please explain why I need to provide them again?\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the most appropriate response?",
    "options": [
      {
        "letter": "a",
        "text": "Close the request.",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "Explain why additional verification may be required and request updated documents if needed.",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "Reject the request.",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "Ask the customer to upload the documents again without explanation.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 81,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 1
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q82",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-3",
    "case_title": "Passage 3 – Account Verification Request",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello,\nI submitted my verification documents yesterday, but I received another message asking me to upload them again. I believe the documents I submitted are correct. Could you please explain why I need to provide them again?\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Based on the customer's message, which conclusion is most reasonable?",
    "options": [
      {
        "letter": "a",
        "text": "The documents definitely meet the verification requirements.",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "The verification team made a mistake.",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "The customer believes the documents are correct, but further review is still required.",
        "is_correct": true
      },
      {
        "letter": "d",
        "text": "The customer's account will be permanently restricted.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 82,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 2
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q83",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-3",
    "case_title": "Passage 3 – Account Verification Request",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello,\nI submitted my verification documents yesterday, but I received another message asking me to upload them again. I believe the documents I submitted are correct. Could you please explain why I need to provide them again?\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "(Select ALL that apply.) Which factors could explain why the customer was asked to submit the documents again?",
    "options": [
      {
        "letter": "a",
        "text": "The uploaded documents were unclear.",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "Required documents were missing.",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "The verification requirements were not fully met.",
        "is_correct": true
      },
      {
        "letter": "d",
        "text": "The customer changed the booking.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 83,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 3
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "eng-reading-q84",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-3",
    "case_title": "Passage 3 – Account Verification Request",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello,\nI submitted my verification documents yesterday, but I received another message asking me to upload them again. I believe the documents I submitted are correct. Could you please explain why I need to provide them again?\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which information should the agent review first?",
    "options": [
      {
        "letter": "a",
        "text": "Customer account rating",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "Previous verification attempts and document quality",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "Customer review history",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "Property information",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 84,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 4
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q85",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-3",
    "case_title": "Passage 3 – Account Verification Request",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello,\nI submitted my verification documents yesterday, but I received another message asking me to upload them again. I believe the documents I submitted are correct. Could you please explain why I need to provide them again?\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What does the customer want to understand?",
    "options": [
      {
        "letter": "a",
        "text": "Why additional documents are required.",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "How to delete an account.",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "How to change a reservation.",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "How to create an account.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 85,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 5
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q86",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-4",
    "case_title": "Passage 4 – Duplicate Reviews Investigation",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello Support Team,\nOver the past three days, my property has received four negative reviews from different accounts. All the reviews were posted within a few hours of each other and contain very similar wording. I also noticed that none of the reviewers have written reviews for any other properties. I believe these reviews may be part of coordinated activity. Please investigate.\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the primary concern raised by the property owner?",
    "options": [
      {
        "letter": "a",
        "text": "The property rating has increased.",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "Multiple similar reviews may be part of coordinated activity.",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "Guests requested refunds.",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "The property listing is incorrect.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 86,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 1
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q87",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-4",
    "case_title": "Passage 4 – Duplicate Reviews Investigation",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello Support Team,\nOver the past three days, my property has received four negative reviews from different accounts. All the reviews were posted within a few hours of each other and contain very similar wording. I also noticed that none of the reviewers have written reviews for any other properties. I believe these reviews may be part of coordinated activity. Please investigate.\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "(Select ALL that apply.) Which details in the message could indicate suspicious activity?",
    "options": [
      {
        "letter": "a",
        "text": "The reviews were posted within a few hours of each other.",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "The reviews contain very similar wording.",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "The reviewer accounts have no review history.",
        "is_correct": true
      },
      {
        "letter": "d",
        "text": "The reviews are negative.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 87,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "eng-reading-q88",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-4",
    "case_title": "Passage 4 – Duplicate Reviews Investigation",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello Support Team,\nOver the past three days, my property has received four negative reviews from different accounts. All the reviews were posted within a few hours of each other and contain very similar wording. I also noticed that none of the reviewers have written reviews for any other properties. I believe these reviews may be part of coordinated activity. Please investigate.\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which action should the agent take first?",
    "options": [
      {
        "letter": "a",
        "text": "Remove all four reviews immediately.",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "Suspend the reviewer accounts.",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "Investigate the available evidence before determining whether any policy violations occurred.",
        "is_correct": true
      },
      {
        "letter": "d",
        "text": "Ask the property owner to respond publicly to the reviews.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 88,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 3
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q89",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-4",
    "case_title": "Passage 4 – Duplicate Reviews Investigation",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello Support Team,\nOver the past three days, my property has received four negative reviews from different accounts. All the reviews were posted within a few hours of each other and contain very similar wording. I also noticed that none of the reviewers have written reviews for any other properties. I believe these reviews may be part of coordinated activity. Please investigate.\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Based on the customer's message, which conclusion is most reasonable?",
    "options": [
      {
        "letter": "a",
        "text": "The reviews definitely violate policy.",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "The reviews appear suspicious, but additional investigation is required before reaching a conclusion.",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "The reviews should automatically be removed.",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "The reviewer accounts are fake.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 89,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 4
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q90",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-4",
    "case_title": "Passage 4 – Duplicate Reviews Investigation",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello Support Team,\nOver the past three days, my property has received four negative reviews from different accounts. All the reviews were posted within a few hours of each other and contain very similar wording. I also noticed that none of the reviewers have written reviews for any other properties. I believe these reviews may be part of coordinated activity. Please investigate.\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "(Select ALL that apply.) Which statements are supported by the passage?",
    "options": [
      {
        "letter": "a",
        "text": "Four reviews were posted within three days.",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "The reviews were submitted by different accounts.",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "The reviews have already been removed.",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "The property owner requested an investigation.",
        "is_correct": true
      }
    ],
    "model_answer": null,
    "position": 90,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 5
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "eng-reading-q91",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-5",
    "case_title": "Passage 5 – Booking Verification Follow-up",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello,\nI booked a stay for June 12–14 and uploaded my booking confirmation along with my payment receipt last week. Today, I received an email saying that my verification could not be completed because supporting documents were missing. I am not sure which documents are missing because I already submitted everything requested. Could you please clarify what additional information is required?\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "(Select ALL that apply.) Which documents does the customer state they have already submitted?",
    "options": [
      {
        "letter": "a",
        "text": "Booking confirmation",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "Payment receipt",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "Government-issued ID",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "Property invoice",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 91,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 1
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "eng-reading-q92",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-5",
    "case_title": "Passage 5 – Booking Verification Follow-up",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello,\nI booked a stay for June 12–14 and uploaded my booking confirmation along with my payment receipt last week. Today, I received an email saying that my verification could not be completed because supporting documents were missing. I am not sure which documents are missing because I already submitted everything requested. Could you please clarify what additional information is required?\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the customer's primary concern?",
    "options": [
      {
        "letter": "a",
        "text": "The booking was cancelled.",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "The payment was declined.",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "They want to understand why additional documents are being requested.",
        "is_correct": true
      },
      {
        "letter": "d",
        "text": "They want to change their travel dates.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 92,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 2
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q93",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-5",
    "case_title": "Passage 5 – Booking Verification Follow-up",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello,\nI booked a stay for June 12–14 and uploaded my booking confirmation along with my payment receipt last week. Today, I received an email saying that my verification could not be completed because supporting documents were missing. I am not sure which documents are missing because I already submitted everything requested. Could you please clarify what additional information is required?\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which information should the agent review first?",
    "options": [
      {
        "letter": "a",
        "text": "The customer's previous reviews.",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "The verification request and the list of documents received.",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "The property's amenities.",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "The customer's booking history from previous years.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 93,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 3
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q94",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-5",
    "case_title": "Passage 5 – Booking Verification Follow-up",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello,\nI booked a stay for June 12–14 and uploaded my booking confirmation along with my payment receipt last week. Today, I received an email saying that my verification could not be completed because supporting documents were missing. I am not sure which documents are missing because I already submitted everything requested. Could you please clarify what additional information is required?\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is NOT supported by the passage?",
    "options": [
      {
        "letter": "a",
        "text": "The customer uploaded a payment receipt.",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "The customer uploaded a booking confirmation.",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "The customer received confirmation that all submitted documents were approved.",
        "is_correct": true
      },
      {
        "letter": "d",
        "text": "The customer wants clarification.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 94,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 4
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-reading-q95",
    "bank": "english",
    "section": "reading",
    "level": null,
    "case_id": "eng-reading-passage-5",
    "case_title": "Passage 5 – Booking Verification Follow-up",
    "tabs": [
      {
        "name": "Passage",
        "content": "Hello,\nI booked a stay for June 12–14 and uploaded my booking confirmation along with my payment receipt last week. Today, I received an email saying that my verification could not be completed because supporting documents were missing. I am not sure which documents are missing because I already submitted everything requested. Could you please clarify what additional information is required?\nThank you.",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "(Select ALL that apply.) Which responses would be appropriate for the agent?",
    "options": [
      {
        "letter": "a",
        "text": "Review the submitted documents before requesting additional information.",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "Explain which documents, if any, are still required.",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "Reject the verification request immediately.",
        "is_correct": false
      },
      {
        "letter": "d",
        "text": "Inform the customer why further verification may be necessary, if applicable.",
        "is_correct": true
      }
    ],
    "model_answer": null,
    "position": 95,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 6: READING COMPREHENSION",
      "number": 5
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "eng-closure-q96",
    "bank": "english",
    "section": "closure",
    "level": null,
    "case_id": "eng-closure-1",
    "case_title": "Q1 – Fake Listing Removed",
    "tabs": null,
    "tables": null,
    "response_type": "hybrid",
    "stem": "A user reported a suspicious property listing. Investigation confirms the listing was already removed due to policy violations.",
    "options": [
      {
        "letter": "a",
        "text": "Open",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "Pending",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "Solved",
        "is_correct": true
      }
    ],
    "model_answer": "Reviewed the reported listing and confirmed it had already been removed due to policy violations. No further action is required from the user.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 1.0, description: "The closure note must use correct tense and agreement with clean punctuation and spelling, no fragments or run-ons. If the note makes sense, award full credit." }
    ] },

    "position": 96,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 7: CASE CLOSURE NOTES",
      "number": 1
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-closure-q97",
    "bank": "english",
    "section": "closure",
    "level": null,
    "case_id": "eng-closure-2",
    "case_title": "Q2 – Review Investigation Completed",
    "tabs": null,
    "tables": null,
    "response_type": "hybrid",
    "stem": "A property owner reported a review as fake. Investigation found no policy violations.",
    "options": [
      {
        "letter": "a",
        "text": "Open",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "Pending",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "Solved",
        "is_correct": true
      }
    ],
    "model_answer": "Reviewed the reported review and available evidence. No policy violations were identified, and the review will remain published. Case resolved.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 1.0, description: "The closure note must be grammatically correct with proper punctuation and register appropriate for an internal case note. If the note makes sense, award full credit." }
    ] },

    "position": 97,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 7: CASE CLOSURE NOTES",
      "number": 2
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-closure-q98",
    "bank": "english",
    "section": "closure",
    "level": null,
    "case_id": "eng-closure-3",
    "case_title": "Q3 – New Suspicious Review Report",
    "tabs": null,
    "tables": null,
    "response_type": "hybrid",
    "stem": "A property owner reported a suspicious review. The report has just been received and no investigation has started yet.",
    "options": [
      {
        "letter": "a",
        "text": "Open",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "Pending",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "Solved",
        "is_correct": false
      }
    ],
    "model_answer": "Received the report regarding a potentially suspicious review. The case has been logged and is awaiting initial investigation.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.4, description: "Grammatically correct; professional punctuation and spelling throughout" },
      { name: "Meaning Preservation", weight: 0.4, description: "States that no policy violations were identified after investigation; confirms the review will remain published; accurately reflects case closure" },
      { name: "Professional Tone", weight: 0.2, description: "Objective, factual tone; neutral regarding the investigation outcome" }
    ] },

    "position": 98,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 7: CASE CLOSURE NOTES",
      "number": 3
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-closure-q99",
    "bank": "english",
    "section": "closure",
    "level": null,
    "case_id": "eng-closure-4",
    "case_title": "Q4 – Information Provided",
    "tabs": null,
    "tables": null,
    "response_type": "hybrid",
    "stem": "A traveler requested verification assistance. All required documents were received and reviewed successfully.",
    "options": [
      {
        "letter": "a",
        "text": "Open",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "Pending",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "Solved",
        "is_correct": true
      }
    ],
    "model_answer": "Reviewed the submitted documents and confirmed that all required information has been successfully verified. No further action is required.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.4, description: "Grammatically correct; appropriate register for a case note" },
      { name: "Meaning Preservation", weight: 0.4, description: "Reflects that the report was just received and investigation has not started; does not imply any findings or resolution prematurely" },
      { name: "Professional Tone", weight: 0.2, description: "Neutral status update; sets expectation that investigation is pending" }
    ] },

    "position": 99,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 7: CASE CLOSURE NOTES",
      "number": 4
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-closure-q100",
    "bank": "english",
    "section": "closure",
    "level": null,
    "case_id": "eng-closure-5",
    "case_title": "Q5 – Blurry ID Images",
    "tabs": null,
    "tables": null,
    "response_type": "hybrid",
    "stem": "A traveler submitted unclear ID images. Clear copies are required before verification can continue.",
    "options": [
      {
        "letter": "a",
        "text": "Open",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "Pending",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "Solved",
        "is_correct": false
      }
    ],
    "model_answer": "Reviewed the submitted verification documents and found the images to be unclear. Requested clearer copies to continue the verification process.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 1.0, description: "The closure note must be grammatically correct with clean punctuation. If the note makes sense, award full credit." }
    ] },

    "position": 100,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 7: CASE CLOSURE NOTES",
      "number": 5
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-closure-q101",
    "bank": "english",
    "section": "closure",
    "level": null,
    "case_id": "eng-closure-6",
    "case_title": "Q6 – Missing Booking Details",
    "tabs": null,
    "tables": null,
    "response_type": "hybrid",
    "stem": "A customer reported a review issue but did not provide the booking information required for investigation.",
    "options": [
      {
        "letter": "a",
        "text": "Open",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "Pending",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "Solved",
        "is_correct": false
      }
    ],
    "model_answer": "Reviewed the reported concern and determined that booking details are required for further investigation. Awaiting the requested information from the customer.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.4, description: "Grammatically correct; professional register maintained throughout" },
      { name: "Meaning Preservation", weight: 0.4, description: "Notes that submitted images were unclear; requests clearer copies; accurately reflects that verification is blocked pending re-upload" },
      { name: "Professional Tone", weight: 0.2, description: "Polite request; non-blaming language toward the traveler" }
    ] },

    "position": 101,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 7: CASE CLOSURE NOTES",
      "number": 6
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-closure-q102",
    "bank": "english",
    "section": "closure",
    "level": null,
    "case_id": "eng-closure-7",
    "case_title": "Q7 – Additional Evidence Required",
    "tabs": null,
    "tables": null,
    "response_type": "hybrid",
    "stem": "A property owner reported suspicious activity but did not provide sufficient supporting evidence.",
    "options": [
      {
        "letter": "a",
        "text": "Open",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "Pending",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "Solved",
        "is_correct": false
      }
    ],
    "model_answer": "Reviewed the reported concern and determined that additional supporting evidence is required before the investigation can continue. Awaiting further information from the property owner.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.4, description: "Grammatically correct; appropriate sentence structure and punctuation" },
      { name: "Meaning Preservation", weight: 0.4, description: "States that booking details are required for the investigation to proceed; reflects the waiting state pending customer response" },
      { name: "Professional Tone", weight: 0.2, description: "Neutral, factual tone; clearly communicates what information is needed" }
    ] },

    "position": 102,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 7: CASE CLOSURE NOTES",
      "number": 7
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-closure-q103",
    "bank": "english",
    "section": "closure",
    "level": null,
    "case_id": "eng-closure-8",
    "case_title": "Q8 – New Verification Request",
    "tabs": null,
    "tables": null,
    "response_type": "hybrid",
    "stem": "A traveler submitted a request for identity verification today. The request has been received but has not yet been reviewed by the investigation team.",
    "options": [
      {
        "letter": "a",
        "text": "Open",
        "is_correct": true
      },
      {
        "letter": "b",
        "text": "Pending",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "Solved",
        "is_correct": false
      }
    ],
    "model_answer": "Received the verification request and supporting documents. The case has been logged and is awaiting initial review.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.4, description: "Grammatically correct; professional punctuation throughout" },
      { name: "Meaning Preservation", weight: 0.4, description: "Explains that additional supporting evidence is required before the investigation can continue; reflects the dependency on the property owner providing more information" },
      { name: "Professional Tone", weight: 0.2, description: "Polite, clear request; professional register" }
    ] },

    "position": 103,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 7: CASE CLOSURE NOTES",
      "number": 8
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-closure-q104",
    "bank": "english",
    "section": "closure",
    "level": null,
    "case_id": "eng-closure-9",
    "case_title": "Q9 – Verification Document Expired",
    "tabs": null,
    "tables": null,
    "response_type": "hybrid",
    "stem": "A customer submitted an expired document for identity verification.",
    "options": [
      {
        "letter": "a",
        "text": "Open",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "Pending",
        "is_correct": true
      },
      {
        "letter": "c",
        "text": "Solved",
        "is_correct": false
      }
    ],
    "model_answer": "Reviewed the submitted verification document and confirmed that it has expired. Requested a valid document to continue the verification process.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.4, description: "Grammatically correct; appropriate register for a case note" },
      { name: "Meaning Preservation", weight: 0.4, description: "Confirms the verification request was received and logged; investigation is pending initial review; does not imply any findings" },
      { name: "Professional Tone", weight: 0.2, description: "Neutral status update; sets expectation for the initial review process" }
    ] },

    "position": 104,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 7: CASE CLOSURE NOTES",
      "number": 9
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "eng-closure-q105",
    "bank": "english",
    "section": "closure",
    "level": null,
    "case_id": "eng-closure-10",
    "case_title": "Q10 – Listing Accuracy Check",
    "tabs": null,
    "tables": null,
    "response_type": "hybrid",
    "stem": "A traveler reported misleading property information. Investigation confirmed that the listing details were accurate.",
    "options": [
      {
        "letter": "a",
        "text": "Open",
        "is_correct": false
      },
      {
        "letter": "b",
        "text": "Pending",
        "is_correct": false
      },
      {
        "letter": "c",
        "text": "Solved",
        "is_correct": true
      }
    ],
    "model_answer": "Reviewed the property listing and the available booking information. The listing details were found to be accurate based on the investigation. Case resolved.",
    rubric: { version: 1, criteria: [
      { name: "Grammar & Mechanics", weight: 0.4, description: "Grammatically correct; professional register maintained" },
      { name: "Meaning Preservation", weight: 0.4, description: "States that the submitted document has expired; requests a valid replacement; accurately reflects that verification is blocked pending a current document" },
      { name: "Professional Tone", weight: 0.2, description: "Polite, clear instruction; non-blaming tone" }
    ] },

    "position": 105,
    "source": {
      "file": "FS Question Bank_English Proficiency V2.docx",
      "section": "PART 7: CASE CLOSURE NOTES",
      "number": 10
    },
    "difficulty_tier": "moderate"
  },
  {
    "id": "att-level-1-q01",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-01",
    "case_title": "THE IMPOSSIBLE ROOM VIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: James Wilson\nRating: 3 Stars\nReview Date: 18 August 2025\nReview Comment:\n\"I loved waking up to the full ocean view from my standard room.\"\nPhotos Attached: Yes",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Completed\nStay Dates: 10 August 2025 – 12 August 2025\nRoom Booked: Standard Room",
        "position": 2
      },
      {
        "name": "Property Listing Information",
        "content": "Property Name: Blue Horizon Resort\nRoom Categories:",
        "position": 3
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: March 2024\nPrevious Reviews: 5\nPrevious Reports: 0",
        "position": 4
      }
    ],
    "tables": [
      {
        "caption": "Property Listing Information",
        "headers": [
          "Room Type",
          "View"
        ],
        "rows": [
          [
            "Standard Room",
            "Garden View"
          ],
          [
            "Deluxe Room",
            "Partial Ocean View"
          ],
          [
            "Premium Suite",
            "Full Ocean View + Balcony"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_single",
    "stem": "Which detail creates a potential inconsistency in the available information?",
    "options": [
      {
        "letter": "A",
        "text": "The guest provided photos with the review",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The review received a 3-star rating",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The reviewer mentioned a full ocean view from a Standard Room",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The guest completed the booking",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 1,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 1",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q02",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-01",
    "case_title": "THE IMPOSSIBLE ROOM VIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: James Wilson\nRating: 3 Stars\nReview Date: 18 August 2025\nReview Comment:\n\"I loved waking up to the full ocean view from my standard room.\"\nPhotos Attached: Yes",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Completed\nStay Dates: 10 August 2025 – 12 August 2025\nRoom Booked: Standard Room",
        "position": 2
      },
      {
        "name": "Property Listing Information",
        "content": "Property Name: Blue Horizon Resort\nRoom Categories:",
        "position": 3
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: March 2024\nPrevious Reviews: 5\nPrevious Reports: 0",
        "position": 4
      }
    ],
    "tables": [
      {
        "caption": "Property Listing Information",
        "headers": [
          "Room Type",
          "View"
        ],
        "rows": [
          [
            "Standard Room",
            "Garden View"
          ],
          [
            "Deluxe Room",
            "Partial Ocean View"
          ],
          [
            "Premium Suite",
            "Full Ocean View + Balcony"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_multi",
    "stem": "Select ALL details that support the possibility that the review may still represent a genuine experience.",
    "options": [
      {
        "letter": "A",
        "text": "The booking status shows a completed stay",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The reviewer has previous review activity",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Standard Rooms provide full ocean views",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The review includes specific details about the stay",
        "is_correct": true
      }
    ],
    "model_answer": null,
    "position": 2,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 1",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q03",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-01",
    "case_title": "THE IMPOSSIBLE ROOM VIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: James Wilson\nRating: 3 Stars\nReview Date: 18 August 2025\nReview Comment:\n\"I loved waking up to the full ocean view from my standard room.\"\nPhotos Attached: Yes",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Completed\nStay Dates: 10 August 2025 – 12 August 2025\nRoom Booked: Standard Room",
        "position": 2
      },
      {
        "name": "Property Listing Information",
        "content": "Property Name: Blue Horizon Resort\nRoom Categories:",
        "position": 3
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: March 2024\nPrevious Reviews: 5\nPrevious Reports: 0",
        "position": 4
      }
    ],
    "tables": [
      {
        "caption": "Property Listing Information",
        "headers": [
          "Room Type",
          "View"
        ],
        "rows": [
          [
            "Standard Room",
            "Garden View"
          ],
          [
            "Deluxe Room",
            "Partial Ocean View"
          ],
          [
            "Premium Suite",
            "Full Ocean View + Balcony"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_single",
    "stem": "Which information does not match between the booking and review details?",
    "options": [
      {
        "letter": "A",
        "text": "Review date and stay date",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Account creation date and review date",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Booked room category and mentioned room view",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Review rating and property rating",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 3,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 1",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q04",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-01",
    "case_title": "THE IMPOSSIBLE ROOM VIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: James Wilson\nRating: 3 Stars\nReview Date: 18 August 2025\nReview Comment:\n\"I loved waking up to the full ocean view from my standard room.\"\nPhotos Attached: Yes",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Completed\nStay Dates: 10 August 2025 – 12 August 2025\nRoom Booked: Standard Room",
        "position": 2
      },
      {
        "name": "Property Listing Information",
        "content": "Property Name: Blue Horizon Resort\nRoom Categories:",
        "position": 3
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: March 2024\nPrevious Reviews: 5\nPrevious Reports: 0",
        "position": 4
      }
    ],
    "tables": [
      {
        "caption": "Property Listing Information",
        "headers": [
          "Room Type",
          "View"
        ],
        "rows": [
          [
            "Standard Room",
            "Garden View"
          ],
          [
            "Deluxe Room",
            "Partial Ocean View"
          ],
          [
            "Premium Suite",
            "Full Ocean View + Balcony"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_single",
    "stem": "Which statement is supported by the available information?",
    "options": [
      {
        "letter": "A",
        "text": "The review is confirmed fake",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The customer did not stay at the property",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The review contains a detail that requires further verification",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property information is incorrect",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 4,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 1",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q05",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-02",
    "case_title": "THE REVIEW BEFORE CHECK-IN",
    "tabs": [
      {
        "name": "Booking Details",
        "content": "Reviewer Name: Sarah Adams\nBooking Status: Confirmed\nCheck-in Date: 25 September 2025\nCheck-out Date: 28 September 2025\nRoom Booked: Deluxe Room",
        "position": 1
      },
      {
        "name": "Review Information",
        "content": "Review Date: 22 September 2025\nRating: 5 Stars\nReview Comment:\n\"The room was beautiful and the staff provided excellent service during my stay.\"",
        "position": 2
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: January 2023\nPrevious Reviews: 15\nPrevious Reports: 0",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail requires attention based on the timeline?",
    "options": [
      {
        "letter": "A",
        "text": "The reviewer gave a 5-star rating",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The account has previous reviews",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The review was submitted before the scheduled check-in date",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The customer booked a Deluxe Room",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 5,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 2",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q06",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-02",
    "case_title": "THE REVIEW BEFORE CHECK-IN",
    "tabs": [
      {
        "name": "Booking Details",
        "content": "Reviewer Name: Sarah Adams\nBooking Status: Confirmed\nCheck-in Date: 25 September 2025\nCheck-out Date: 28 September 2025\nRoom Booked: Deluxe Room",
        "position": 1
      },
      {
        "name": "Review Information",
        "content": "Review Date: 22 September 2025\nRating: 5 Stars\nReview Comment:\n\"The room was beautiful and the staff provided excellent service during my stay.\"",
        "position": 2
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: January 2023\nPrevious Reviews: 15\nPrevious Reports: 0",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that are consistent with a normal review pattern.",
    "options": [
      {
        "letter": "A",
        "text": "The account has previous review activity",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "A booking exists for the property",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The review was posted after the completed stay",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The review confirms the customer completed the stay",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 6,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 2",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q07",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-02",
    "case_title": "THE REVIEW BEFORE CHECK-IN",
    "tabs": [
      {
        "name": "Booking Details",
        "content": "Reviewer Name: Sarah Adams\nBooking Status: Confirmed\nCheck-in Date: 25 September 2025\nCheck-out Date: 28 September 2025\nRoom Booked: Deluxe Room",
        "position": 1
      },
      {
        "name": "Review Information",
        "content": "Review Date: 22 September 2025\nRating: 5 Stars\nReview Comment:\n\"The room was beautiful and the staff provided excellent service during my stay.\"",
        "position": 2
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: January 2023\nPrevious Reviews: 15\nPrevious Reports: 0",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is accurate based on the available information?",
    "options": [
      {
        "letter": "A",
        "text": "The review is definitely fake",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The customer definitely completed the stay",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The review timeline does not match the booking timeline",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Confirmed bookings always allow reviews before check-in",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 7,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 2",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q08",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-02",
    "case_title": "THE REVIEW BEFORE CHECK-IN",
    "tabs": [
      {
        "name": "Booking Details",
        "content": "Reviewer Name: Sarah Adams\nBooking Status: Confirmed\nCheck-in Date: 25 September 2025\nCheck-out Date: 28 September 2025\nRoom Booked: Deluxe Room",
        "position": 1
      },
      {
        "name": "Review Information",
        "content": "Review Date: 22 September 2025\nRating: 5 Stars\nReview Comment:\n\"The room was beautiful and the staff provided excellent service during my stay.\"",
        "position": 2
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: January 2023\nPrevious Reviews: 15\nPrevious Reports: 0",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which information gap is present in this case?",
    "options": [
      {
        "letter": "A",
        "text": "The property rating is unavailable",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The booking completion status is unavailable",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The reviewer account history is unavailable",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The room category is unavailable",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 8,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 2",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q09",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-03",
    "case_title": "THE INCORRECT STAY DURATION",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Michael Brown\nReview Date: 15 October 2025\nReview Comment:\n\"I stayed at this hotel for one week. The location was excellent and the rooms were comfortable.\"",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Completed\nCheck-in Date: 10 October 2025\nCheck-out Date: 12 October 2025\nTotal Stay Duration: 2 Nights",
        "position": 2
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: 2023\nPrevious Reviews: 12\nPrevious Reports: 0",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail does not match the available information?",
    "options": [
      {
        "letter": "A",
        "text": "The review date",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The customer’s account age",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The stay duration mentioned in the review and booking record",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The booking status",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 9,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 3",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q10",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-03",
    "case_title": "THE INCORRECT STAY DURATION",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Michael Brown\nReview Date: 15 October 2025\nReview Comment:\n\"I stayed at this hotel for one week. The location was excellent and the rooms were comfortable.\"",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Completed\nCheck-in Date: 10 October 2025\nCheck-out Date: 12 October 2025\nTotal Stay Duration: 2 Nights",
        "position": 2
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: 2023\nPrevious Reviews: 12\nPrevious Reports: 0",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that require attention.",
    "options": [
      {
        "letter": "A",
        "text": "Review mentions a one-week stay",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Booking shows a two-night stay",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Customer has previous reviews",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Booking status is completed",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 10,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 3",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q11",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-03",
    "case_title": "THE INCORRECT STAY DURATION",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Michael Brown\nReview Date: 15 October 2025\nReview Comment:\n\"I stayed at this hotel for one week. The location was excellent and the rooms were comfortable.\"",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Completed\nCheck-in Date: 10 October 2025\nCheck-out Date: 12 October 2025\nTotal Stay Duration: 2 Nights",
        "position": 2
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: 2023\nPrevious Reviews: 12\nPrevious Reports: 0",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which conclusion is supported by the evidence?",
    "options": [
      {
        "letter": "A",
        "text": "The review is confirmed fraudulent",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The customer did not stay at the property",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The review contains a discrepancy that requires evaluation",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The booking information must be incorrect",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 11,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 3",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q12",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-03",
    "case_title": "THE INCORRECT STAY DURATION",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Michael Brown\nReview Date: 15 October 2025\nReview Comment:\n\"I stayed at this hotel for one week. The location was excellent and the rooms were comfortable.\"",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Completed\nCheck-in Date: 10 October 2025\nCheck-out Date: 12 October 2025\nTotal Stay Duration: 2 Nights",
        "position": 2
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: 2023\nPrevious Reviews: 12\nPrevious Reports: 0",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which additional detail would help explain the discrepancy?",
    "options": [
      {
        "letter": "A",
        "text": "Property rating",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Whether the guest extended their stay separately",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Number of reviews received by the property",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Review rating",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 12,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 3",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q13",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-04",
    "case_title": "DUPLICATE REVIEW PATTERN",
    "tabs": [
      {
        "name": "Alex Carterctivity",
        "content": "User A\nTaylor Smith\nCreated: 10 January 2025\nReview Date: 12 January 2025\nDevice Used: Device X\nReview:\n\"Amazing hotel, excellent service.\"\nUser B\nTaylor Smith\nCreated: 10 January 2025\nReview Date: 12 January 2025\nDevice Used: Device X\nReview:\n\"Amazing hotel, excellent service.\"\nUser C\nTaylor Smith\nCreated: 2022\nReview Date: 15 January 2025\nDevice Used: Device Y\nReview:\n\"Comfortable stay and helpful staff.\"",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which activity pattern requires attention?",
    "options": [
      {
        "letter": "A",
        "text": "User C’s account history",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "User A and User B showing identical activity patterns",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "User C’s different review wording",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "User A having a recent account",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 13,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 4",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q14",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-04",
    "case_title": "DUPLICATE REVIEW PATTERN",
    "tabs": [
      {
        "name": "Alex Carterctivity",
        "content": "User A\nTaylor Smith\nCreated: 10 January 2025\nReview Date: 12 January 2025\nDevice Used: Device X\nReview:\n\"Amazing hotel, excellent service.\"\nUser B\nTaylor Smith\nCreated: 10 January 2025\nReview Date: 12 January 2025\nDevice Used: Device X\nReview:\n\"Amazing hotel, excellent service.\"\nUser C\nTaylor Smith\nCreated: 2022\nReview Date: 15 January 2025\nDevice Used: Device Y\nReview:\n\"Comfortable stay and helpful staff.\"",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that create a potential concern.",
    "options": [
      {
        "letter": "A",
        "text": "Identical review wording",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Same review date",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Shared device information",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Different review wording from User C",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 14,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 4",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q15",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-04",
    "case_title": "DUPLICATE REVIEW PATTERN",
    "tabs": [
      {
        "name": "Alex Carterctivity",
        "content": "User A\nTaylor Smith\nCreated: 10 January 2025\nReview Date: 12 January 2025\nDevice Used: Device X\nReview:\n\"Amazing hotel, excellent service.\"\nUser B\nTaylor Smith\nCreated: 10 January 2025\nReview Date: 12 January 2025\nDevice Used: Device X\nReview:\n\"Amazing hotel, excellent service.\"\nUser C\nTaylor Smith\nCreated: 2022\nReview Date: 15 January 2025\nDevice Used: Device Y\nReview:\n\"Comfortable stay and helpful staff.\"",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is supported by the information provided?",
    "options": [
      {
        "letter": "A",
        "text": "User A and User B are confirmed to be the same person",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The reviews should automatically be removed",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "User A and User B show indicators requiring further review",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "User C is part of the same activity pattern",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 15,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 4",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q16",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-04",
    "case_title": "DUPLICATE REVIEW PATTERN",
    "tabs": [
      {
        "name": "Alex Carterctivity",
        "content": "User A\nTaylor Smith\nCreated: 10 January 2025\nReview Date: 12 January 2025\nDevice Used: Device X\nReview:\n\"Amazing hotel, excellent service.\"\nUser B\nTaylor Smith\nCreated: 10 January 2025\nReview Date: 12 January 2025\nDevice Used: Device X\nReview:\n\"Amazing hotel, excellent service.\"\nUser C\nTaylor Smith\nCreated: 2022\nReview Date: 15 January 2025\nDevice Used: Device Y\nReview:\n\"Comfortable stay and helpful staff.\"",
        "position": 1
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail reduces concern for User C?",
    "options": [
      {
        "letter": "A",
        "text": "Same review date as User A and User B",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Different device and different review content",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Same account creation date",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Identical wording",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 16,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 4",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q17",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-05",
    "case_title": "THE NEGATIVE BUT VALID REVIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Emma Johnson\nRating: 1 Star\nReview Date: 20 November 2025\nReview Comment:\n\"The room was smaller than expected, but the staff was friendly and helpful.\"\nPhotos Attached: Yes",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Verified\nStay Completed: Yes",
        "position": 2
      },
      {
        "name": "Property Report",
        "content": "Report Reason:\n\"The review is unfair and damages our reputation.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which details support the possibility that the review reflects a genuine experience?",
    "options": [
      {
        "letter": "A",
        "text": "The review has a low rating",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The property reported the review",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Verified stay, specific experience details, and photos",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The review affects the property's reputation",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 17,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 5",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q18",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-05",
    "case_title": "THE NEGATIVE BUT VALID REVIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Emma Johnson\nRating: 1 Star\nReview Date: 20 November 2025\nReview Comment:\n\"The room was smaller than expected, but the staff was friendly and helpful.\"\nPhotos Attached: Yes",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Verified\nStay Completed: Yes",
        "position": 2
      },
      {
        "name": "Property Report",
        "content": "Report Reason:\n\"The review is unfair and damages our reputation.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that support review credibility.",
    "options": [
      {
        "letter": "A",
        "text": "Completed stay",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Specific description of the experience",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Attached photos",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Property disagreement with the review",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 18,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 5",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q19",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-05",
    "case_title": "THE NEGATIVE BUT VALID REVIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Emma Johnson\nRating: 1 Star\nReview Date: 20 November 2025\nReview Comment:\n\"The room was smaller than expected, but the staff was friendly and helpful.\"\nPhotos Attached: Yes",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Verified\nStay Completed: Yes",
        "position": 2
      },
      {
        "name": "Property Report",
        "content": "Report Reason:\n\"The review is unfair and damages our reputation.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is accurate based on the available information?",
    "options": [
      {
        "letter": "A",
        "text": "Negative reviews are always suspicious",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Property complaints confirm review violations",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "A negative review can still be genuine if it reflects a real experience",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "One-star reviews cannot be published",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 19,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 5",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q20",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-05",
    "case_title": "THE NEGATIVE BUT VALID REVIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Emma Johnson\nRating: 1 Star\nReview Date: 20 November 2025\nReview Comment:\n\"The room was smaller than expected, but the staff was friendly and helpful.\"\nPhotos Attached: Yes",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Verified\nStay Completed: Yes",
        "position": 2
      },
      {
        "name": "Property Report",
        "content": "Report Reason:\n\"The review is unfair and damages our reputation.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What information is most relevant when assessing this review?",
    "options": [
      {
        "letter": "A",
        "text": "Whether the property likes the rating",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Whether the review violates review guidelines",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Whether the review affects the property score",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Whether the rating is positive or negative",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 20,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 5",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q21",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-06",
    "case_title": "WRONG PROPERTY INFORMATION IN REVIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: David Clark\nRating: 4 Stars\nReview Comment:\n\"The beach access was convenient and the hotel provided airport shuttle service.\"",
        "position": 1
      },
      {
        "name": "Property Listing Information",
        "content": "Property Name: Mountain View Retreat\nAvailable Facilities:\nSwimming Pool\nRestaurant\nSpa\nParking\nNot Listed:\nAirport Shuttle\nBeach Access",
        "position": 2
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Completed\nStay Duration: 5 Nights",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which details in the review require attention?",
    "options": [
      {
        "letter": "A",
        "text": "The review rating",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The mention of beach access and airport shuttle service",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The completed booking status",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The stay duration",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 21,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 6",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q22",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-06",
    "case_title": "WRONG PROPERTY INFORMATION IN REVIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: David Clark\nRating: 4 Stars\nReview Comment:\n\"The beach access was convenient and the hotel provided airport shuttle service.\"",
        "position": 1
      },
      {
        "name": "Property Listing Information",
        "content": "Property Name: Mountain View Retreat\nAvailable Facilities:\nSwimming Pool\nRestaurant\nSpa\nParking\nNot Listed:\nAirport Shuttle\nBeach Access",
        "position": 2
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Completed\nStay Duration: 5 Nights",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that create a possible inconsistency.",
    "options": [
      {
        "letter": "A",
        "text": "Airport shuttle is not listed as an available facility",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Beach access is not mentioned in the property information",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The customer completed a 5-night stay",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The review has a 4-star rating",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 22,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 6",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q23",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-06",
    "case_title": "WRONG PROPERTY INFORMATION IN REVIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: David Clark\nRating: 4 Stars\nReview Comment:\n\"The beach access was convenient and the hotel provided airport shuttle service.\"",
        "position": 1
      },
      {
        "name": "Property Listing Information",
        "content": "Property Name: Mountain View Retreat\nAvailable Facilities:\nSwimming Pool\nRestaurant\nSpa\nParking\nNot Listed:\nAirport Shuttle\nBeach Access",
        "position": 2
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Completed\nStay Duration: 5 Nights",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is supported by the available information?",
    "options": [
      {
        "letter": "A",
        "text": "The review is confirmed fake",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The property definitely provided incorrect information",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The mentioned facilities require additional verification",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The customer did not stay at the property",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 23,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 6",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q24",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-06",
    "case_title": "WRONG PROPERTY INFORMATION IN REVIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: David Clark\nRating: 4 Stars\nReview Comment:\n\"The beach access was convenient and the hotel provided airport shuttle service.\"",
        "position": 1
      },
      {
        "name": "Property Listing Information",
        "content": "Property Name: Mountain View Retreat\nAvailable Facilities:\nSwimming Pool\nRestaurant\nSpa\nParking\nNot Listed:\nAirport Shuttle\nBeach Access",
        "position": 2
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Completed\nStay Duration: 5 Nights",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which additional information would help clarify the concern?",
    "options": [
      {
        "letter": "A",
        "text": "Property rating history",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Whether these services were available during the customer’s stay",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Number of reviews received by the property",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Customer’s previous review rating",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 24,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 6",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q25",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-07",
    "case_title": "NEW ACCOUNT WITH DETAILED EXPERIENCE",
    "tabs": [
      {
        "name": "Reviewer Profile",
        "content": "Taylor Smith\nCreated: 5 December 2025\nReview Posted: 10 December 2025\nPrevious Reviews: 0",
        "position": 1
      },
      {
        "name": "Review Information",
        "content": "Rating: 5 Stars\nReview Comment:\n\"The check-in process was smooth. The receptionist helped us arrange transportation, and the breakfast area was crowded during mornings.\"\nPhotos Attached: Yes",
        "position": 2
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Verified\nStay Completed: Yes",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail may require attention?",
    "options": [
      {
        "letter": "A",
        "text": "The account is newly created",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The review contains specific details",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Photos were attached",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The stay was completed",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 25,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 7",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q26",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-07",
    "case_title": "NEW ACCOUNT WITH DETAILED EXPERIENCE",
    "tabs": [
      {
        "name": "Reviewer Profile",
        "content": "Taylor Smith\nCreated: 5 December 2025\nReview Posted: 10 December 2025\nPrevious Reviews: 0",
        "position": 1
      },
      {
        "name": "Review Information",
        "content": "Rating: 5 Stars\nReview Comment:\n\"The check-in process was smooth. The receptionist helped us arrange transportation, and the breakfast area was crowded during mornings.\"\nPhotos Attached: Yes",
        "position": 2
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Verified\nStay Completed: Yes",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that support review authenticity.",
    "options": [
      {
        "letter": "A",
        "text": "Verified booking",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Completed stay",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Specific experience details",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Original photos attached",
        "is_correct": true
      }
    ],
    "model_answer": null,
    "position": 26,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 7",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q27",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-07",
    "case_title": "NEW ACCOUNT WITH DETAILED EXPERIENCE",
    "tabs": [
      {
        "name": "Reviewer Profile",
        "content": "Taylor Smith\nCreated: 5 December 2025\nReview Posted: 10 December 2025\nPrevious Reviews: 0",
        "position": 1
      },
      {
        "name": "Review Information",
        "content": "Rating: 5 Stars\nReview Comment:\n\"The check-in process was smooth. The receptionist helped us arrange transportation, and the breakfast area was crowded during mornings.\"\nPhotos Attached: Yes",
        "position": 2
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Verified\nStay Completed: Yes",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is accurate?",
    "options": [
      {
        "letter": "A",
        "text": "New accounts should always be considered fraudulent",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "A new account alone is not enough to confirm a fake review",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Reviews from new accounts cannot be published",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Detailed reviews are always suspicious",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 27,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 7",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q28",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-07",
    "case_title": "NEW ACCOUNT WITH DETAILED EXPERIENCE",
    "tabs": [
      {
        "name": "Reviewer Profile",
        "content": "Taylor Smith\nCreated: 5 December 2025\nReview Posted: 10 December 2025\nPrevious Reviews: 0",
        "position": 1
      },
      {
        "name": "Review Information",
        "content": "Rating: 5 Stars\nReview Comment:\n\"The check-in process was smooth. The receptionist helped us arrange transportation, and the breakfast area was crowded during mornings.\"\nPhotos Attached: Yes",
        "position": 2
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Verified\nStay Completed: Yes",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which information should be considered together when reviewing this case?",
    "options": [
      {
        "letter": "A",
        "text": "Only account creation date",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Only review rating",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Account history, booking details, and review content",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Only the attached photos",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 28,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 7",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q29",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-08",
    "case_title": "REVIEW FROM A NON-GUEST EXPERIENCE",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Lisa Martin\nReview Comment:\n\"I visited this restaurant during my friend's birthday dinner. The food quality was excellent.\"",
        "position": 1
      },
      {
        "name": "Property Information",
        "content": "Property Type: Restaurant",
        "position": 2
      },
      {
        "name": "Booking Information",
        "content": "Reservation: Not Available",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail requires attention?",
    "options": [
      {
        "letter": "A",
        "text": "The reviewer did not provide a rating",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The reviewer does not have a hotel booking",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The review mentions food quality",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The property is a restaurant",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 29,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 8",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q30",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-08",
    "case_title": "REVIEW FROM A NON-GUEST EXPERIENCE",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Lisa Martin\nReview Comment:\n\"I visited this restaurant during my friend's birthday dinner. The food quality was excellent.\"",
        "position": 1
      },
      {
        "name": "Property Information",
        "content": "Property Type: Restaurant",
        "position": 2
      },
      {
        "name": "Booking Information",
        "content": "Reservation: Not Available",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that support the reviewer’s experience.",
    "options": [
      {
        "letter": "A",
        "text": "The reviewer mentioned a specific visit",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The review describes a personal experience",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "A hotel booking exists",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The reviewer stayed overnight",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 30,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 8",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q31",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-08",
    "case_title": "REVIEW FROM A NON-GUEST EXPERIENCE",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Lisa Martin\nReview Comment:\n\"I visited this restaurant during my friend's birthday dinner. The food quality was excellent.\"",
        "position": 1
      },
      {
        "name": "Property Information",
        "content": "Property Type: Restaurant",
        "position": 2
      },
      {
        "name": "Booking Information",
        "content": "Reservation: Not Available",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is correct?",
    "options": [
      {
        "letter": "A",
        "text": "Every review must have a hotel booking",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "A reviewer must stay overnight to leave feedback",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Requirements may vary depending on the type of experience being reviewed",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Reviews without bookings are automatically invalid",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 31,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 8",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q32",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-08",
    "case_title": "REVIEW FROM A NON-GUEST EXPERIENCE",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Lisa Martin\nReview Comment:\n\"I visited this restaurant during my friend's birthday dinner. The food quality was excellent.\"",
        "position": 1
      },
      {
        "name": "Property Information",
        "content": "Property Type: Restaurant",
        "position": 2
      },
      {
        "name": "Booking Information",
        "content": "Reservation: Not Available",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What information creates the biggest misunderstanding in this case?",
    "options": [
      {
        "letter": "A",
        "text": "The reviewer mentioned a birthday dinner",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The property type and expected booking requirement are different",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The review describes food quality",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The reviewer did not mention staff names",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 32,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 8",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q33",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-09",
    "case_title": "MULTIPLE REPORTS AGAINST ONE REVIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: John Miller\nRating: 2 Stars\nReview Comment:\n\"The room was smaller than expected, but the location was convenient.\"",
        "position": 1
      },
      {
        "name": "Reports Received",
        "content": "Property Report:\n\"Customer is trying to damage our reputation.\"\nCustomer Feedback:\n3 users marked the review as helpful",
        "position": 2
      },
      {
        "name": "Reviewer Profile",
        "content": "Alex Carterge: 4 Years\nPrevious Reviews: 18\nPrevious Reports: 0",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which details support the credibility of the review?",
    "options": [
      {
        "letter": "A",
        "text": "Property disagreement with the review",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Reviewer account history and specific experience details",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Low rating given",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Number of reports received",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 33,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 9",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q34",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-09",
    "case_title": "MULTIPLE REPORTS AGAINST ONE REVIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: John Miller\nRating: 2 Stars\nReview Comment:\n\"The room was smaller than expected, but the location was convenient.\"",
        "position": 1
      },
      {
        "name": "Reports Received",
        "content": "Property Report:\n\"Customer is trying to damage our reputation.\"\nCustomer Feedback:\n3 users marked the review as helpful",
        "position": 2
      },
      {
        "name": "Reviewer Profile",
        "content": "Alex Carterge: 4 Years\nPrevious Reviews: 18\nPrevious Reports: 0",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that require evaluation.",
    "options": [
      {
        "letter": "A",
        "text": "Property claim that the review is damaging reputation",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Review content and whether it reflects an actual experience",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The review rating alone",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The property’s opinion only",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 34,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 9",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q35",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-09",
    "case_title": "MULTIPLE REPORTS AGAINST ONE REVIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: John Miller\nRating: 2 Stars\nReview Comment:\n\"The room was smaller than expected, but the location was convenient.\"",
        "position": 1
      },
      {
        "name": "Reports Received",
        "content": "Property Report:\n\"Customer is trying to damage our reputation.\"\nCustomer Feedback:\n3 users marked the review as helpful",
        "position": 2
      },
      {
        "name": "Reviewer Profile",
        "content": "Alex Carterge: 4 Years\nPrevious Reviews: 18\nPrevious Reports: 0",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is accurate?",
    "options": [
      {
        "letter": "A",
        "text": "Multiple complaints automatically prove the review is fake",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "A property report alone does not confirm a violation",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Negative reviews cannot be genuine",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Helpful votes confirm policy compliance",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 35,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 9",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q36",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-09",
    "case_title": "MULTIPLE REPORTS AGAINST ONE REVIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: John Miller\nRating: 2 Stars\nReview Comment:\n\"The room was smaller than expected, but the location was convenient.\"",
        "position": 1
      },
      {
        "name": "Reports Received",
        "content": "Property Report:\n\"Customer is trying to damage our reputation.\"\nCustomer Feedback:\n3 users marked the review as helpful",
        "position": 2
      },
      {
        "name": "Reviewer Profile",
        "content": "Alex Carterge: 4 Years\nPrevious Reviews: 18\nPrevious Reports: 0",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which information should be given more importance when assessing authenticity?",
    "options": [
      {
        "letter": "A",
        "text": "Whether the property agrees with the review",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Evidence supporting whether the review reflects a real experience",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Whether the rating is low",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Number of reports received",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 36,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 9",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q37",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-10",
    "case_title": "CONNECTED ACCOUNT RISK",
    "tabs": [
      {
        "name": "Reviewer Profile",
        "content": "Taylor Smith\nCreated: 1 July 2025\nReview Posted: 2 July 2025\nPrevious Reviews: 0",
        "position": 1
      },
      {
        "name": "Account Information",
        "content": "Device Information:\nDevice connected to:\nCurrent account\nTwo previously suspended accounts",
        "position": 2
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Verified\nStay Completed: Yes",
        "position": 3
      },
      {
        "name": "Review Information",
        "content": "Review Comment:\n\"The room was clean, the staff was helpful, and the location was convenient.\"",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail creates the strongest concern?",
    "options": [
      {
        "letter": "A",
        "text": "The review contains positive feedback",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The account has no previous reviews",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The device is connected to previously suspended accounts",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The booking was completed",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 37,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 10",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q38",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-10",
    "case_title": "CONNECTED ACCOUNT RISK",
    "tabs": [
      {
        "name": "Reviewer Profile",
        "content": "Taylor Smith\nCreated: 1 July 2025\nReview Posted: 2 July 2025\nPrevious Reviews: 0",
        "position": 1
      },
      {
        "name": "Account Information",
        "content": "Device Information:\nDevice connected to:\nCurrent account\nTwo previously suspended accounts",
        "position": 2
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Verified\nStay Completed: Yes",
        "position": 3
      },
      {
        "name": "Review Information",
        "content": "Review Comment:\n\"The room was clean, the staff was helpful, and the location was convenient.\"",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that should be considered when reviewing this case.",
    "options": [
      {
        "letter": "A",
        "text": "Device connection history",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Verified booking information",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Review content",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Review rating alone",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 38,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 10",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q39",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-10",
    "case_title": "CONNECTED ACCOUNT RISK",
    "tabs": [
      {
        "name": "Reviewer Profile",
        "content": "Taylor Smith\nCreated: 1 July 2025\nReview Posted: 2 July 2025\nPrevious Reviews: 0",
        "position": 1
      },
      {
        "name": "Account Information",
        "content": "Device Information:\nDevice connected to:\nCurrent account\nTwo previously suspended accounts",
        "position": 2
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Verified\nStay Completed: Yes",
        "position": 3
      },
      {
        "name": "Review Information",
        "content": "Review Comment:\n\"The room was clean, the staff was helpful, and the location was convenient.\"",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is supported by the available information?",
    "options": [
      {
        "letter": "A",
        "text": "A verified booking removes all concerns",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The account is confirmed fraudulent",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The account contains a risk indicator requiring further review",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "All reviews from new accounts are suspicious",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 39,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 10",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q40",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-10",
    "case_title": "CONNECTED ACCOUNT RISK",
    "tabs": [
      {
        "name": "Reviewer Profile",
        "content": "Taylor Smith\nCreated: 1 July 2025\nReview Posted: 2 July 2025\nPrevious Reviews: 0",
        "position": 1
      },
      {
        "name": "Account Information",
        "content": "Device Information:\nDevice connected to:\nCurrent account\nTwo previously suspended accounts",
        "position": 2
      },
      {
        "name": "Booking Details",
        "content": "Booking Status: Verified\nStay Completed: Yes",
        "position": 3
      },
      {
        "name": "Review Information",
        "content": "Review Comment:\n\"The room was clean, the staff was helpful, and the location was convenient.\"",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which combination of information creates the need for closer review?",
    "options": [
      {
        "letter": "A",
        "text": "New account + connected device history + completed booking",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Positive review + completed booking",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Detailed review + helpful staff mention",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Verified booking + property location",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 40,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 10",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q41",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-11",
    "case_title": "THE MISSING BOOKING CONNECTION",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Robert Taylor\nRating: 1 Star\nReview Comment:\n\"The staff refused to provide the room I booked and treated me poorly throughout my stay.\"\nReview Date: 12 December 2025",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Guest Name: Robert Taylor\nBooking Status: Cancelled\nCancellation Date: 5 days before check-in\nStay Completed: No",
        "position": 2
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: 2021\nPrevious Reviews: 25\nPrevious Reports: 0",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail creates a possible inconsistency?",
    "options": [
      {
        "letter": "A",
        "text": "The review has a low rating",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The account has previous activity",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The review describes a completed stay despite no completed stay record",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The customer cancelled the booking",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 41,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 11",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q42",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-11",
    "case_title": "THE MISSING BOOKING CONNECTION",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Robert Taylor\nRating: 1 Star\nReview Comment:\n\"The staff refused to provide the room I booked and treated me poorly throughout my stay.\"\nReview Date: 12 December 2025",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Guest Name: Robert Taylor\nBooking Status: Cancelled\nCancellation Date: 5 days before check-in\nStay Completed: No",
        "position": 2
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: 2021\nPrevious Reviews: 25\nPrevious Reports: 0",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that require attention.",
    "options": [
      {
        "letter": "A",
        "text": "Booking was cancelled before check-in",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Review mentions an experience during a stay",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Account has previous reviews",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Review contains negative feedback",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 42,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 11",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q43",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-11",
    "case_title": "THE MISSING BOOKING CONNECTION",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Robert Taylor\nRating: 1 Star\nReview Comment:\n\"The staff refused to provide the room I booked and treated me poorly throughout my stay.\"\nReview Date: 12 December 2025",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Guest Name: Robert Taylor\nBooking Status: Cancelled\nCancellation Date: 5 days before check-in\nStay Completed: No",
        "position": 2
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: 2021\nPrevious Reviews: 25\nPrevious Reports: 0",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is supported by the available information?",
    "options": [
      {
        "letter": "A",
        "text": "The review is confirmed fake",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The customer definitely did not visit the property",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The review contains a stay-related claim that requires verification",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "All cancelled bookings cannot have reviews",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 43,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 11",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q44",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-11",
    "case_title": "THE MISSING BOOKING CONNECTION",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Robert Taylor\nRating: 1 Star\nReview Comment:\n\"The staff refused to provide the room I booked and treated me poorly throughout my stay.\"\nReview Date: 12 December 2025",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Guest Name: Robert Taylor\nBooking Status: Cancelled\nCancellation Date: 5 days before check-in\nStay Completed: No",
        "position": 2
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: 2021\nPrevious Reviews: 25\nPrevious Reports: 0",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which additional information would help clarify the situation?",
    "options": [
      {
        "letter": "A",
        "text": "Property rating",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Whether the customer had another completed booking or stay record",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Number of reviews on the property",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Review length",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 44,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 11",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q45",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-12",
    "case_title": "THE WRONG ROOM CATEGORY CLAIM",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The room was advertised as a luxury suite, but the room I received was much smaller.\"",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Room Booked: Standard Room\nStay Status: Completed",
        "position": 2
      },
      {
        "name": "Property Listing Information",
        "content": "Room Categories:",
        "position": 3
      },
      {
        "name": "Review Information",
        "content": "Customer Review:\n\"The room was clean, but smaller than expected.\"",
        "position": 4
      }
    ],
    "tables": [
      {
        "caption": "Property Listing Information",
        "headers": [
          "Room Type",
          "Details"
        ],
        "rows": [
          [
            "Standard Room",
            "Basic room, 20 sq. meters"
          ],
          [
            "Deluxe Room",
            "Larger room, 35 sq. meters"
          ],
          [
            "Luxury Suite",
            "Separate living area, balcony"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_single",
    "stem": "Which detail requires attention?",
    "options": [
      {
        "letter": "A",
        "text": "The customer provided negative feedback",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The customer may have compared the room with a different category than booked",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The room was clean",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The booking was completed",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 45,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 12",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q46",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-12",
    "case_title": "THE WRONG ROOM CATEGORY CLAIM",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The room was advertised as a luxury suite, but the room I received was much smaller.\"",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Room Booked: Standard Room\nStay Status: Completed",
        "position": 2
      },
      {
        "name": "Property Listing Information",
        "content": "Room Categories:",
        "position": 3
      },
      {
        "name": "Review Information",
        "content": "Customer Review:\n\"The room was clean, but smaller than expected.\"",
        "position": 4
      }
    ],
    "tables": [
      {
        "caption": "Property Listing Information",
        "headers": [
          "Room Type",
          "Details"
        ],
        "rows": [
          [
            "Standard Room",
            "Basic room, 20 sq. meters"
          ],
          [
            "Deluxe Room",
            "Larger room, 35 sq. meters"
          ],
          [
            "Luxury Suite",
            "Separate living area, balcony"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_multi",
    "stem": "Select ALL details that match the available information.",
    "options": [
      {
        "letter": "A",
        "text": "Standard Room is smaller than Luxury Suite",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Customer booked a Standard Room",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Review mentions the room was smaller",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Customer booked a Luxury Suite",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 46,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 12",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q47",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-12",
    "case_title": "THE WRONG ROOM CATEGORY CLAIM",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The room was advertised as a luxury suite, but the room I received was much smaller.\"",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Room Booked: Standard Room\nStay Status: Completed",
        "position": 2
      },
      {
        "name": "Property Listing Information",
        "content": "Room Categories:",
        "position": 3
      },
      {
        "name": "Review Information",
        "content": "Customer Review:\n\"The room was clean, but smaller than expected.\"",
        "position": 4
      }
    ],
    "tables": [
      {
        "caption": "Property Listing Information",
        "headers": [
          "Room Type",
          "Details"
        ],
        "rows": [
          [
            "Standard Room",
            "Basic room, 20 sq. meters"
          ],
          [
            "Deluxe Room",
            "Larger room, 35 sq. meters"
          ],
          [
            "Luxury Suite",
            "Separate living area, balcony"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_single",
    "stem": "Which statement is accurate?",
    "options": [
      {
        "letter": "A",
        "text": "The listing is confirmed misleading",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The customer received the wrong room",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The available information shows different room categories with different features",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "All rooms should have the same size",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 47,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 12",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q48",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-12",
    "case_title": "THE WRONG ROOM CATEGORY CLAIM",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The room was advertised as a luxury suite, but the room I received was much smaller.\"",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Room Booked: Standard Room\nStay Status: Completed",
        "position": 2
      },
      {
        "name": "Property Listing Information",
        "content": "Room Categories:",
        "position": 3
      },
      {
        "name": "Review Information",
        "content": "Customer Review:\n\"The room was clean, but smaller than expected.\"",
        "position": 4
      }
    ],
    "tables": [
      {
        "caption": "Property Listing Information",
        "headers": [
          "Room Type",
          "Details"
        ],
        "rows": [
          [
            "Standard Room",
            "Basic room, 20 sq. meters"
          ],
          [
            "Deluxe Room",
            "Larger room, 35 sq. meters"
          ],
          [
            "Luxury Suite",
            "Separate living area, balcony"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_single",
    "stem": "Which information should be compared?",
    "options": [
      {
        "letter": "A",
        "text": "Customer review rating and property rating",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Booked room category and room description shown during booking",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Property popularity and review count",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Customer account age and room size",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 48,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 12",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q49",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-13",
    "case_title": "THE TIMELINE CHANGE IN LISTING INFORMATION",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The property advertised free breakfast when I booked, but breakfast was not included during my stay.\"",
        "position": 1
      },
      {
        "name": "Listing History",
        "content": "Previous Listing Information:\nBreakfast Included: Yes\nUpdate Made: 1 June 2025\nBreakfast Included: No",
        "position": 2
      },
      {
        "name": "Booking Details",
        "content": "Booking Date: 15 June 2025\nStay Date: 20 June 2025 – 22 June 2025",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail requires attention?",
    "options": [
      {
        "letter": "A",
        "text": "The customer complained about breakfast",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The listing information changed before the booking date",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The stay lasted two nights",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The property updated information",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 49,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 13",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q50",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-13",
    "case_title": "THE TIMELINE CHANGE IN LISTING INFORMATION",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The property advertised free breakfast when I booked, but breakfast was not included during my stay.\"",
        "position": 1
      },
      {
        "name": "Listing History",
        "content": "Previous Listing Information:\nBreakfast Included: Yes\nUpdate Made: 1 June 2025\nBreakfast Included: No",
        "position": 2
      },
      {
        "name": "Booking Details",
        "content": "Booking Date: 15 June 2025\nStay Date: 20 June 2025 – 22 June 2025",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that are relevant for comparison.",
    "options": [
      {
        "letter": "A",
        "text": "Listing status at booking time",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Booking date",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Previous listing information",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Property rating",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 50,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 13",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q51",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-13",
    "case_title": "THE TIMELINE CHANGE IN LISTING INFORMATION",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The property advertised free breakfast when I booked, but breakfast was not included during my stay.\"",
        "position": 1
      },
      {
        "name": "Listing History",
        "content": "Previous Listing Information:\nBreakfast Included: Yes\nUpdate Made: 1 June 2025\nBreakfast Included: No",
        "position": 2
      },
      {
        "name": "Booking Details",
        "content": "Booking Date: 15 June 2025\nStay Date: 20 June 2025 – 22 June 2025",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is supported by the information?",
    "options": [
      {
        "letter": "A",
        "text": "The property definitely misled the customer",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The listing history needs to be reviewed based on timing",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Previous listing information is always applicable",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Current listing information is the only relevant detail",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 51,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 13",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q52",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-13",
    "case_title": "THE TIMELINE CHANGE IN LISTING INFORMATION",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The property advertised free breakfast when I booked, but breakfast was not included during my stay.\"",
        "position": 1
      },
      {
        "name": "Listing History",
        "content": "Previous Listing Information:\nBreakfast Included: Yes\nUpdate Made: 1 June 2025\nBreakfast Included: No",
        "position": 2
      },
      {
        "name": "Booking Details",
        "content": "Booking Date: 15 June 2025\nStay Date: 20 June 2025 – 22 June 2025",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail is most important when comparing the information?",
    "options": [
      {
        "letter": "A",
        "text": "Date when the listing was updated compared with booking date",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Number of reviews received",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Customer account age",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Property rating",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 52,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 13",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q53",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-14",
    "case_title": "THE OUTDATED PROPERTY PHOTOS",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The property photos showed a modern lobby, but the property looked different when I arrived.\"",
        "position": 1
      },
      {
        "name": "Property Information",
        "content": "Photos Uploaded: 2022\nProperty Renovation Completed: 2024",
        "position": 2
      },
      {
        "name": "Current Listing",
        "content": "Description:\n\"Recently renovated property with updated facilities.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail creates a possible concern?",
    "options": [
      {
        "letter": "A",
        "text": "The customer disliked the property",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The photos may not represent the current property condition",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The property completed renovation",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The listing has a description",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 53,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 14",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q54",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-14",
    "case_title": "THE OUTDATED PROPERTY PHOTOS",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The property photos showed a modern lobby, but the property looked different when I arrived.\"",
        "position": 1
      },
      {
        "name": "Property Information",
        "content": "Photos Uploaded: 2022\nProperty Renovation Completed: 2024",
        "position": 2
      },
      {
        "name": "Current Listing",
        "content": "Description:\n\"Recently renovated property with updated facilities.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that require comparison.",
    "options": [
      {
        "letter": "A",
        "text": "Photo upload date",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Renovation completion date",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Current listing information",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Customer rating preference",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 54,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 14",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q55",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-14",
    "case_title": "THE OUTDATED PROPERTY PHOTOS",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The property photos showed a modern lobby, but the property looked different when I arrived.\"",
        "position": 1
      },
      {
        "name": "Property Information",
        "content": "Photos Uploaded: 2022\nProperty Renovation Completed: 2024",
        "position": 2
      },
      {
        "name": "Current Listing",
        "content": "Description:\n\"Recently renovated property with updated facilities.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is accurate?",
    "options": [
      {
        "letter": "A",
        "text": "Old photos automatically prove fraud",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The property must remove all photos",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The photos may require review because they predate renovations",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Renovated properties cannot use old photos",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 55,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 14",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q56",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-14",
    "case_title": "THE OUTDATED PROPERTY PHOTOS",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The property photos showed a modern lobby, but the property looked different when I arrived.\"",
        "position": 1
      },
      {
        "name": "Property Information",
        "content": "Photos Uploaded: 2022\nProperty Renovation Completed: 2024",
        "position": 2
      },
      {
        "name": "Current Listing",
        "content": "Description:\n\"Recently renovated property with updated facilities.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which information would help determine listing accuracy?",
    "options": [
      {
        "letter": "A",
        "text": "Updated property photos and listing history",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Number of customer reviews",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Customer account age",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Property rating",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 56,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 14",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q57",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-15",
    "case_title": "THE AMENITY THAT CHANGED",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The listing mentioned a swimming pool, but there was no pool available during my stay.\"",
        "position": 1
      },
      {
        "name": "Current Listing Information",
        "content": "Available Amenities:\nRestaurant\nGym\nParking\nSwimming Pool: Not listed",
        "position": 2
      },
      {
        "name": "Listing History",
        "content": "Previous Listing (3 months earlier):\nAmenities:\nRestaurant\nGym\nParking\nSwimming Pool",
        "position": 3
      },
      {
        "name": "Booking Details",
        "content": "Booking Date: 2 months after the previous listing update\nStay Completed: Yes",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail requires attention?",
    "options": [
      {
        "letter": "A",
        "text": "The customer mentioned a missing amenity",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Previous listing information included a swimming pool, but current listing does not",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The booking was completed",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The property has a gym",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 57,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 15",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q58",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-15",
    "case_title": "THE AMENITY THAT CHANGED",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The listing mentioned a swimming pool, but there was no pool available during my stay.\"",
        "position": 1
      },
      {
        "name": "Current Listing Information",
        "content": "Available Amenities:\nRestaurant\nGym\nParking\nSwimming Pool: Not listed",
        "position": 2
      },
      {
        "name": "Listing History",
        "content": "Previous Listing (3 months earlier):\nAmenities:\nRestaurant\nGym\nParking\nSwimming Pool",
        "position": 3
      },
      {
        "name": "Booking Details",
        "content": "Booking Date: 2 months after the previous listing update\nStay Completed: Yes",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that may explain the customer’s concern.",
    "options": [
      {
        "letter": "A",
        "text": "Previous listing showed a swimming pool",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Current listing does not show a swimming pool",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Customer completed the stay",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Property has parking",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 58,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 15",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q59",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-15",
    "case_title": "THE AMENITY THAT CHANGED",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The listing mentioned a swimming pool, but there was no pool available during my stay.\"",
        "position": 1
      },
      {
        "name": "Current Listing Information",
        "content": "Available Amenities:\nRestaurant\nGym\nParking\nSwimming Pool: Not listed",
        "position": 2
      },
      {
        "name": "Listing History",
        "content": "Previous Listing (3 months earlier):\nAmenities:\nRestaurant\nGym\nParking\nSwimming Pool",
        "position": 3
      },
      {
        "name": "Booking Details",
        "content": "Booking Date: 2 months after the previous listing update\nStay Completed: Yes",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is supported by the information?",
    "options": [
      {
        "letter": "A",
        "text": "The property definitely provided false information",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The customer’s concern requires review using listing history and timing",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Previous listings are always applicable",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Amenities never change",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 59,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 15",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q60",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-15",
    "case_title": "THE AMENITY THAT CHANGED",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The listing mentioned a swimming pool, but there was no pool available during my stay.\"",
        "position": 1
      },
      {
        "name": "Current Listing Information",
        "content": "Available Amenities:\nRestaurant\nGym\nParking\nSwimming Pool: Not listed",
        "position": 2
      },
      {
        "name": "Listing History",
        "content": "Previous Listing (3 months earlier):\nAmenities:\nRestaurant\nGym\nParking\nSwimming Pool",
        "position": 3
      },
      {
        "name": "Booking Details",
        "content": "Booking Date: 2 months after the previous listing update\nStay Completed: Yes",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which information is most important to compare?",
    "options": [
      {
        "letter": "A",
        "text": "Listing version available at the time of booking and customer stay date",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Number of property reviews",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Customer rating",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Property name",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 60,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 15",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q61",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-16",
    "case_title": "THE UNEXPECTED LOCATION CLAIM",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The hotel was advertised as being near the airport, but it took almost an hour to reach.\"",
        "position": 1
      },
      {
        "name": "Property Listing Information",
        "content": "Property Description:\n\"Located in the city center with easy access to major attractions.\"\nAddress:\n15 Park Street, Downtown Area",
        "position": 2
      },
      {
        "name": "Location Details",
        "content": "Distance:\nAirport → Property: 35 km\nCity Center → Property: 2 km",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail requires attention based on the available information?",
    "options": [
      {
        "letter": "A",
        "text": "The customer expected a shorter travel time from the airport",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The listing does not mention that the property is near the airport",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The property is located downtown",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The customer provided a complaint",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 61,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 16",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q62",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-16",
    "case_title": "THE UNEXPECTED LOCATION CLAIM",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The hotel was advertised as being near the airport, but it took almost an hour to reach.\"",
        "position": 1
      },
      {
        "name": "Property Listing Information",
        "content": "Property Description:\n\"Located in the city center with easy access to major attractions.\"\nAddress:\n15 Park Street, Downtown Area",
        "position": 2
      },
      {
        "name": "Location Details",
        "content": "Distance:\nAirport → Property: 35 km\nCity Center → Property: 2 km",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that should be compared.",
    "options": [
      {
        "letter": "A",
        "text": "Property description",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Official property location",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Customer claim about location",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Property review rating",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 62,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 16",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q63",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-16",
    "case_title": "THE UNEXPECTED LOCATION CLAIM",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The hotel was advertised as being near the airport, but it took almost an hour to reach.\"",
        "position": 1
      },
      {
        "name": "Property Listing Information",
        "content": "Property Description:\n\"Located in the city center with easy access to major attractions.\"\nAddress:\n15 Park Street, Downtown Area",
        "position": 2
      },
      {
        "name": "Location Details",
        "content": "Distance:\nAirport → Property: 35 km\nCity Center → Property: 2 km",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is supported by the available information?",
    "options": [
      {
        "letter": "A",
        "text": "The listing is confirmed inaccurate",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The customer’s expectation may not match the information provided in the listing",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The property must be removed",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The customer’s complaint automatically proves misleading information",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 63,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 16",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q64",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-16",
    "case_title": "THE UNEXPECTED LOCATION CLAIM",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The hotel was advertised as being near the airport, but it took almost an hour to reach.\"",
        "position": 1
      },
      {
        "name": "Property Listing Information",
        "content": "Property Description:\n\"Located in the city center with easy access to major attractions.\"\nAddress:\n15 Park Street, Downtown Area",
        "position": 2
      },
      {
        "name": "Location Details",
        "content": "Distance:\nAirport → Property: 35 km\nCity Center → Property: 2 km",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which information would help clarify the concern?",
    "options": [
      {
        "letter": "A",
        "text": "Whether airport proximity was mentioned anywhere in the booking flow",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Number of property reviews",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Property rating",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Customer’s previous stays",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 64,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 16",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q65",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-17",
    "case_title": "THE BREAKFAST PACKAGE CONFUSION",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The property charged me for breakfast even though the listing said breakfast was included.\"",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Room Booked: Standard Room\nPackage Selected: Room Only",
        "position": 2
      },
      {
        "name": "Property Listing Information",
        "content": "Room Options:",
        "position": 3
      }
    ],
    "tables": [
      {
        "caption": "Property Listing Information",
        "headers": [
          "Room Type",
          "Breakfast"
        ],
        "rows": [
          [
            "Standard Room",
            "Not Included"
          ],
          [
            "Premium Room",
            "Included"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_single",
    "stem": "Which detail creates a possible inconsistency?",
    "options": [
      {
        "letter": "A",
        "text": "Customer expected breakfast based on another room category",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Customer completed the booking",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The property has multiple room options",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Breakfast is available at the property",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 65,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 17",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q66",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-17",
    "case_title": "THE BREAKFAST PACKAGE CONFUSION",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The property charged me for breakfast even though the listing said breakfast was included.\"",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Room Booked: Standard Room\nPackage Selected: Room Only",
        "position": 2
      },
      {
        "name": "Property Listing Information",
        "content": "Room Options:",
        "position": 3
      }
    ],
    "tables": [
      {
        "caption": "Property Listing Information",
        "headers": [
          "Room Type",
          "Breakfast"
        ],
        "rows": [
          [
            "Standard Room",
            "Not Included"
          ],
          [
            "Premium Room",
            "Included"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_multi",
    "stem": "Select ALL details that support the available information.",
    "options": [
      {
        "letter": "A",
        "text": "Standard Room does not include breakfast",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Premium Room includes breakfast",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Customer booked Standard Room",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "All rooms include breakfast",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 66,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 17",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q67",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-17",
    "case_title": "THE BREAKFAST PACKAGE CONFUSION",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The property charged me for breakfast even though the listing said breakfast was included.\"",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Room Booked: Standard Room\nPackage Selected: Room Only",
        "position": 2
      },
      {
        "name": "Property Listing Information",
        "content": "Room Options:",
        "position": 3
      }
    ],
    "tables": [
      {
        "caption": "Property Listing Information",
        "headers": [
          "Room Type",
          "Breakfast"
        ],
        "rows": [
          [
            "Standard Room",
            "Not Included"
          ],
          [
            "Premium Room",
            "Included"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_single",
    "stem": "Which statement is accurate?",
    "options": [
      {
        "letter": "A",
        "text": "The property definitely charged incorrectly",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The listing appears to separate breakfast availability by room category",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Breakfast must always be included",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Room categories do not affect amenities",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 67,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 17",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q68",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-17",
    "case_title": "THE BREAKFAST PACKAGE CONFUSION",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The property charged me for breakfast even though the listing said breakfast was included.\"",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Room Booked: Standard Room\nPackage Selected: Room Only",
        "position": 2
      },
      {
        "name": "Property Listing Information",
        "content": "Room Options:",
        "position": 3
      }
    ],
    "tables": [
      {
        "caption": "Property Listing Information",
        "headers": [
          "Room Type",
          "Breakfast"
        ],
        "rows": [
          [
            "Standard Room",
            "Not Included"
          ],
          [
            "Premium Room",
            "Included"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_single",
    "stem": "Which information should be compared?",
    "options": [
      {
        "letter": "A",
        "text": "Booked room category and included benefits shown during booking",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Customer review history",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Property popularity",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Number of available rooms",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 68,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 17",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q69",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-18",
    "case_title": "THE RENOVATION DISCLOSURE GAP",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The hotel was under renovation during my stay, but I was not informed.\"",
        "position": 1
      },
      {
        "name": "Property Information",
        "content": "Listing Description:\n\"Quiet rooms with modern facilities.\"",
        "position": 2
      },
      {
        "name": "Property Updates",
        "content": "Renovation Start Date: 5 July 2025\nCustomer Stay Date: 15 July 2025 – 18 July 2025\nListing Update Date: 20 July 2025",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail requires attention?",
    "options": [
      {
        "letter": "A",
        "text": "The customer stayed for three nights",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Renovation started before the customer's stay, but the listing was updated afterward",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The hotel has modern facilities",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The customer submitted a complaint",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 69,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 18",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q70",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-18",
    "case_title": "THE RENOVATION DISCLOSURE GAP",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The hotel was under renovation during my stay, but I was not informed.\"",
        "position": 1
      },
      {
        "name": "Property Information",
        "content": "Listing Description:\n\"Quiet rooms with modern facilities.\"",
        "position": 2
      },
      {
        "name": "Property Updates",
        "content": "Renovation Start Date: 5 July 2025\nCustomer Stay Date: 15 July 2025 – 18 July 2025\nListing Update Date: 20 July 2025",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details relevant to evaluating the concern.",
    "options": [
      {
        "letter": "A",
        "text": "Renovation start date",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Customer stay date",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Listing update date",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Property rating",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 70,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 18",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q71",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-18",
    "case_title": "THE RENOVATION DISCLOSURE GAP",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The hotel was under renovation during my stay, but I was not informed.\"",
        "position": 1
      },
      {
        "name": "Property Information",
        "content": "Listing Description:\n\"Quiet rooms with modern facilities.\"",
        "position": 2
      },
      {
        "name": "Property Updates",
        "content": "Renovation Start Date: 5 July 2025\nCustomer Stay Date: 15 July 2025 – 18 July 2025\nListing Update Date: 20 July 2025",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is supported by the information?",
    "options": [
      {
        "letter": "A",
        "text": "The listing information may not have reflected the renovation status during the stay",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The customer complaint is automatically false",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Renovation does not affect listing accuracy",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The property must be permanently removed",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 71,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 18",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q72",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-18",
    "case_title": "THE RENOVATION DISCLOSURE GAP",
    "tabs": [
      {
        "name": "Customer Complaint",
        "content": "Customer Statement:\n\"The hotel was under renovation during my stay, but I was not informed.\"",
        "position": 1
      },
      {
        "name": "Property Information",
        "content": "Listing Description:\n\"Quiet rooms with modern facilities.\"",
        "position": 2
      },
      {
        "name": "Property Updates",
        "content": "Renovation Start Date: 5 July 2025\nCustomer Stay Date: 15 July 2025 – 18 July 2025\nListing Update Date: 20 July 2025",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail creates the timeline concern?",
    "options": [
      {
        "letter": "A",
        "text": "Renovation started before the customer stayed and listing update occurred later",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Customer stayed during summer",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Property had modern facilities",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Customer submitted feedback",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 72,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 18",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q73",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-19",
    "case_title": "THE REVIEW FROM THE WRONG PROPERTY",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Daniel Lee\nReview Comment:\n\"The hotel room was clean, and the staff was very helpful.\"",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Booked Property: Sunrise Hotel\nStay Status: Completed",
        "position": 2
      },
      {
        "name": "Review Metadata",
        "content": "Review Submitted For: Sunrise Hotel",
        "position": 3
      },
      {
        "name": "Customer Communication",
        "content": "Customer Message:\n\"I am reviewing the property I stayed at last month.\"",
        "position": 4
      },
      {
        "name": "Property Information",
        "content": "Sunrise Hotel:\nHotel rooms\nRestaurant\nGym\nNearby Property:\nSunrise Resort\nSimilar name",
        "position": 5
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail may create confusion?",
    "options": [
      {
        "letter": "A",
        "text": "Similar names between two properties",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Customer completed a stay",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Review contains positive feedback",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Hotel has a restaurant",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 73,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 19",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q74",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-19",
    "case_title": "THE REVIEW FROM THE WRONG PROPERTY",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Daniel Lee\nReview Comment:\n\"The hotel room was clean, and the staff was very helpful.\"",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Booked Property: Sunrise Hotel\nStay Status: Completed",
        "position": 2
      },
      {
        "name": "Review Metadata",
        "content": "Review Submitted For: Sunrise Hotel",
        "position": 3
      },
      {
        "name": "Customer Communication",
        "content": "Customer Message:\n\"I am reviewing the property I stayed at last month.\"",
        "position": 4
      },
      {
        "name": "Property Information",
        "content": "Sunrise Hotel:\nHotel rooms\nRestaurant\nGym\nNearby Property:\nSunrise Resort\nSimilar name",
        "position": 5
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that should be compared.",
    "options": [
      {
        "letter": "A",
        "text": "Booked property name",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Review destination/property name",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Property details",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Review rating only",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 74,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 19",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q75",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-19",
    "case_title": "THE REVIEW FROM THE WRONG PROPERTY",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Daniel Lee\nReview Comment:\n\"The hotel room was clean, and the staff was very helpful.\"",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Booked Property: Sunrise Hotel\nStay Status: Completed",
        "position": 2
      },
      {
        "name": "Review Metadata",
        "content": "Review Submitted For: Sunrise Hotel",
        "position": 3
      },
      {
        "name": "Customer Communication",
        "content": "Customer Message:\n\"I am reviewing the property I stayed at last month.\"",
        "position": 4
      },
      {
        "name": "Property Information",
        "content": "Sunrise Hotel:\nHotel rooms\nRestaurant\nGym\nNearby Property:\nSunrise Resort\nSimilar name",
        "position": 5
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is accurate?",
    "options": [
      {
        "letter": "A",
        "text": "Similar property names automatically mean the review is invalid",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The property identity should be verified due to possible confusion",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Positive reviews do not require verification",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "All similar properties are connected",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 75,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 19",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q76",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-19",
    "case_title": "THE REVIEW FROM THE WRONG PROPERTY",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Daniel Lee\nReview Comment:\n\"The hotel room was clean, and the staff was very helpful.\"",
        "position": 1
      },
      {
        "name": "Booking Details",
        "content": "Booked Property: Sunrise Hotel\nStay Status: Completed",
        "position": 2
      },
      {
        "name": "Review Metadata",
        "content": "Review Submitted For: Sunrise Hotel",
        "position": 3
      },
      {
        "name": "Customer Communication",
        "content": "Customer Message:\n\"I am reviewing the property I stayed at last month.\"",
        "position": 4
      },
      {
        "name": "Property Information",
        "content": "Sunrise Hotel:\nHotel rooms\nRestaurant\nGym\nNearby Property:\nSunrise Resort\nSimilar name",
        "position": 5
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which information would help confirm the correct property?",
    "options": [
      {
        "letter": "A",
        "text": "Booking confirmation details",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Number of property photos",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Property rating",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Review length",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 76,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 19",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q77",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-20",
    "case_title": "THE MIXED INFORMATION REVIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Anna Wilson\nReview Comment:\n\"The hotel had a rooftop pool, airport pickup, and a private beach. The room was comfortable.\"",
        "position": 1
      },
      {
        "name": "Property Listing Information",
        "content": "Available Facilities:\nRooftop Restaurant\nGym\nParking\nNot Listed:\nRooftop Pool\nAirport Pickup\nPrivate Beach Access",
        "position": 2
      },
      {
        "name": "Booking Information",
        "content": "Booking Status: Completed\nStay Duration: 4 Nights",
        "position": 3
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: 2020\nPrevious Reviews: 30\nPrevious Reports: 0",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which details require attention?",
    "options": [
      {
        "letter": "A",
        "text": "The reviewer has previous activity",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The review mentions multiple facilities not shown in the listing",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The booking was completed",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The review mentions room comfort",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 77,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 20",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q78",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-20",
    "case_title": "THE MIXED INFORMATION REVIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Anna Wilson\nReview Comment:\n\"The hotel had a rooftop pool, airport pickup, and a private beach. The room was comfortable.\"",
        "position": 1
      },
      {
        "name": "Property Listing Information",
        "content": "Available Facilities:\nRooftop Restaurant\nGym\nParking\nNot Listed:\nRooftop Pool\nAirport Pickup\nPrivate Beach Access",
        "position": 2
      },
      {
        "name": "Booking Information",
        "content": "Booking Status: Completed\nStay Duration: 4 Nights",
        "position": 3
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: 2020\nPrevious Reviews: 30\nPrevious Reports: 0",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that may require verification.",
    "options": [
      {
        "letter": "A",
        "text": "Rooftop pool claim",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Airport pickup claim",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Private beach access claim",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Room comfort statement",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 78,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 20",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-1-q79",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-20",
    "case_title": "THE MIXED INFORMATION REVIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Anna Wilson\nReview Comment:\n\"The hotel had a rooftop pool, airport pickup, and a private beach. The room was comfortable.\"",
        "position": 1
      },
      {
        "name": "Property Listing Information",
        "content": "Available Facilities:\nRooftop Restaurant\nGym\nParking\nNot Listed:\nRooftop Pool\nAirport Pickup\nPrivate Beach Access",
        "position": 2
      },
      {
        "name": "Booking Information",
        "content": "Booking Status: Completed\nStay Duration: 4 Nights",
        "position": 3
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: 2020\nPrevious Reviews: 30\nPrevious Reports: 0",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is supported by the evidence?",
    "options": [
      {
        "letter": "A",
        "text": "The review is fake because some amenities are not listed",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The reviewer did not stay at the property",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Some review details require verification against available property information",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property information must always match every review statement",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 79,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 20",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-1-q80",
    "bank": "attention",
    "section": "level_1",
    "level": "L1",
    "case_id": "attn-l1-case-20",
    "case_title": "THE MIXED INFORMATION REVIEW",
    "tabs": [
      {
        "name": "Review Information",
        "content": "Reviewer Name: Anna Wilson\nReview Comment:\n\"The hotel had a rooftop pool, airport pickup, and a private beach. The room was comfortable.\"",
        "position": 1
      },
      {
        "name": "Property Listing Information",
        "content": "Available Facilities:\nRooftop Restaurant\nGym\nParking\nNot Listed:\nRooftop Pool\nAirport Pickup\nPrivate Beach Access",
        "position": 2
      },
      {
        "name": "Booking Information",
        "content": "Booking Status: Completed\nStay Duration: 4 Nights",
        "position": 3
      },
      {
        "name": "Account Information",
        "content": "Taylor Smith\nCreated: 2020\nPrevious Reviews: 30\nPrevious Reports: 0",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which information helps evaluate the review credibility?",
    "options": [
      {
        "letter": "A",
        "text": "Booking status, account history, and property details",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Review rating only",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Property popularity only",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Number of photos only",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 80,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 1 Case 20",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q81",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-01",
    "case_title": "SAME DEVICE, MULTIPLE ACCOUNTS",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nTaylor Smith\nCreated: 10 January 2025\nPrevious Reviews: 0\nVerification Status: Verified\nJordan Lee\nTaylor Smith\nCreated: 12 January 2025\nPrevious Reviews: 1\nVerification Status: Verified\nTaylor Smith\nTaylor Smith\nCreated: 2021\nPrevious Reviews: 25\nVerification Status: Verified",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Alex Carter\nDevice ID: Device-458\nLocation: Chennai, India\nJordan Lee\nDevice ID: Device-458\nLocation: Chennai, India\nTaylor Smith\nDevice ID: Device-982\nLocation: Mumbai, India",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Alex Carter\nProperty Reviewed: Ocean View Hotel\nRating: 5 Stars\nReview Date: 15 January 2025\nJordan Lee\nProperty Reviewed: Ocean View Hotel\nRating: 5 Stars\nReview Date: 15 January 2025\nTaylor Smith\nProperty Reviewed: City Palace Hotel\nRating: 4 Stars\nReview Date: 20 January 2025",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which account activity shows a potential risk indicator?",
    "options": [
      {
        "letter": "A",
        "text": "Taylor Smith has multiple reviews",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Alex Carter and Jordan Lee reviewed the same property on the same date using the same device",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Alex Carter has no previous reviews",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Taylor Smith uses a different device",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 81,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 1",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q82",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-01",
    "case_title": "SAME DEVICE, MULTIPLE ACCOUNTS",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nTaylor Smith\nCreated: 10 January 2025\nPrevious Reviews: 0\nVerification Status: Verified\nJordan Lee\nTaylor Smith\nCreated: 12 January 2025\nPrevious Reviews: 1\nVerification Status: Verified\nTaylor Smith\nTaylor Smith\nCreated: 2021\nPrevious Reviews: 25\nVerification Status: Verified",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Alex Carter\nDevice ID: Device-458\nLocation: Chennai, India\nJordan Lee\nDevice ID: Device-458\nLocation: Chennai, India\nTaylor Smith\nDevice ID: Device-982\nLocation: Mumbai, India",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Alex Carter\nProperty Reviewed: Ocean View Hotel\nRating: 5 Stars\nReview Date: 15 January 2025\nJordan Lee\nProperty Reviewed: Ocean View Hotel\nRating: 5 Stars\nReview Date: 15 January 2025\nTaylor Smith\nProperty Reviewed: City Palace Hotel\nRating: 4 Stars\nReview Date: 20 January 2025",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that create a connection between Alex Carter and Jordan Lee.",
    "options": [
      {
        "letter": "A",
        "text": "Same device ID",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Same location",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Same property reviewed on the same date",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Same account creation year",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 82,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 1",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q83",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-01",
    "case_title": "SAME DEVICE, MULTIPLE ACCOUNTS",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nTaylor Smith\nCreated: 10 January 2025\nPrevious Reviews: 0\nVerification Status: Verified\nJordan Lee\nTaylor Smith\nCreated: 12 January 2025\nPrevious Reviews: 1\nVerification Status: Verified\nTaylor Smith\nTaylor Smith\nCreated: 2021\nPrevious Reviews: 25\nVerification Status: Verified",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Alex Carter\nDevice ID: Device-458\nLocation: Chennai, India\nJordan Lee\nDevice ID: Device-458\nLocation: Chennai, India\nTaylor Smith\nDevice ID: Device-982\nLocation: Mumbai, India",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Alex Carter\nProperty Reviewed: Ocean View Hotel\nRating: 5 Stars\nReview Date: 15 January 2025\nJordan Lee\nProperty Reviewed: Ocean View Hotel\nRating: 5 Stars\nReview Date: 15 January 2025\nTaylor Smith\nProperty Reviewed: City Palace Hotel\nRating: 4 Stars\nReview Date: 20 January 2025",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Does the available information confirm that Alex Carter and Jordan Lee are fraudulent?",
    "options": [
      {
        "letter": "A",
        "text": "Yes, shared devices always confirm fraud",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Yes, because both accounts gave five-star ratings",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "No, the information shows a connection that requires further review",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "No, because new accounts cannot be suspicious",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 83,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 1",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q84",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-01",
    "case_title": "SAME DEVICE, MULTIPLE ACCOUNTS",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nTaylor Smith\nCreated: 10 January 2025\nPrevious Reviews: 0\nVerification Status: Verified\nJordan Lee\nTaylor Smith\nCreated: 12 January 2025\nPrevious Reviews: 1\nVerification Status: Verified\nTaylor Smith\nTaylor Smith\nCreated: 2021\nPrevious Reviews: 25\nVerification Status: Verified",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Alex Carter\nDevice ID: Device-458\nLocation: Chennai, India\nJordan Lee\nDevice ID: Device-458\nLocation: Chennai, India\nTaylor Smith\nDevice ID: Device-982\nLocation: Mumbai, India",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Alex Carter\nProperty Reviewed: Ocean View Hotel\nRating: 5 Stars\nReview Date: 15 January 2025\nJordan Lee\nProperty Reviewed: Ocean View Hotel\nRating: 5 Stars\nReview Date: 15 January 2025\nTaylor Smith\nProperty Reviewed: City Palace Hotel\nRating: 4 Stars\nReview Date: 20 January 2025",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement best describes the risk signal?",
    "options": [
      {
        "letter": "A",
        "text": "Multiple indicators suggest coordinated activity between accounts",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The accounts have different review ratings",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The accounts are verified, so there are no risks",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The accounts have different creation dates, so they are unrelated",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 84,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 1",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q85",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-02",
    "case_title": "SUDDEN REVIEW ACTIVITY SPIKE",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Alex Morgan\nAlex Carterge: 4 Years\nPrevious Reviews: 6\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Historical Activity:\n6 reviews posted over 4 years\nRecent Activity:\n20 reviews posted within 5 days",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Recent reviews:\nAll rated 5 Stars\nSimilar wording pattern\nDifferent properties reviewed\nExample:\nReview 1:\n\"Amazing experience, highly recommended.\"\nReview 2:\n\"Amazing stay, highly recommended.\"\nReview 3:\n\"Excellent experience, highly recommended.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which behaviour requires attention?",
    "options": [
      {
        "letter": "A",
        "text": "The account is four years old",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The user posted significantly more reviews than their normal pattern",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The reviews have positive ratings",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The user reviewed different properties",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 85,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 2",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q86",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-02",
    "case_title": "SUDDEN REVIEW ACTIVITY SPIKE",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Alex Morgan\nAlex Carterge: 4 Years\nPrevious Reviews: 6\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Historical Activity:\n6 reviews posted over 4 years\nRecent Activity:\n20 reviews posted within 5 days",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Recent reviews:\nAll rated 5 Stars\nSimilar wording pattern\nDifferent properties reviewed\nExample:\nReview 1:\n\"Amazing experience, highly recommended.\"\nReview 2:\n\"Amazing stay, highly recommended.\"\nReview 3:\n\"Excellent experience, highly recommended.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL indicators that may require review.",
    "options": [
      {
        "letter": "A",
        "text": "Sudden increase in activity",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similar wording across reviews",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Account age of four years",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Positive ratings alone",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 86,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 2",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q87",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-02",
    "case_title": "SUDDEN REVIEW ACTIVITY SPIKE",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Alex Morgan\nAlex Carterge: 4 Years\nPrevious Reviews: 6\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Historical Activity:\n6 reviews posted over 4 years\nRecent Activity:\n20 reviews posted within 5 days",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Recent reviews:\nAll rated 5 Stars\nSimilar wording pattern\nDifferent properties reviewed\nExample:\nReview 1:\n\"Amazing experience, highly recommended.\"\nReview 2:\n\"Amazing stay, highly recommended.\"\nReview 3:\n\"Excellent experience, highly recommended.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Does high review activity alone confirm suspicious behaviour?",
    "options": [
      {
        "letter": "A",
        "text": "Yes",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "No, it is only one risk indicator requiring additional context",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Yes, because active users are always fraudulent",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "No, because old accounts cannot be suspicious",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 87,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 2",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q88",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-02",
    "case_title": "SUDDEN REVIEW ACTIVITY SPIKE",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Alex Morgan\nAlex Carterge: 4 Years\nPrevious Reviews: 6\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Historical Activity:\n6 reviews posted over 4 years\nRecent Activity:\n20 reviews posted within 5 days",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Recent reviews:\nAll rated 5 Stars\nSimilar wording pattern\nDifferent properties reviewed\nExample:\nReview 1:\n\"Amazing experience, highly recommended.\"\nReview 2:\n\"Amazing stay, highly recommended.\"\nReview 3:\n\"Excellent experience, highly recommended.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which information supports evaluating this activity?",
    "options": [
      {
        "letter": "A",
        "text": "Comparison between historical behaviour and recent activity pattern",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Review rating only",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Account age only",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Property popularity only",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 88,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 2",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q89",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-03",
    "case_title": "CONNECTED TO A SUSPENDED ACCOUNT",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Current Account\nTaylor Smith\nCreated: March 2025\nVerified Email: Yes\nPrevious Reviews: 2\nPrevious Violations: 0",
        "position": 1
      },
      {
        "name": "Booking Information",
        "content": "Booking Status: Completed\nStay Verified: Yes\nPhotos Uploaded: Yes",
        "position": 2
      },
      {
        "name": "Connected Information",
        "content": "Device Information:\nCurrent Account Device:\nDevice ID: Device-789\nPrevious Suspended Account:\nDevice ID: Device-789",
        "position": 3
      },
      {
        "name": "Review Activity",
        "content": "Review Content:\n\"The room was clean, the staff was helpful, and the location was convenient.\"",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail creates a potential risk indicator?",
    "options": [
      {
        "letter": "A",
        "text": "Verified booking",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Original photos uploaded",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Device connection with a previously suspended account",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Detailed review content",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 89,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 3",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q90",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-03",
    "case_title": "CONNECTED TO A SUSPENDED ACCOUNT",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Current Account\nTaylor Smith\nCreated: March 2025\nVerified Email: Yes\nPrevious Reviews: 2\nPrevious Violations: 0",
        "position": 1
      },
      {
        "name": "Booking Information",
        "content": "Booking Status: Completed\nStay Verified: Yes\nPhotos Uploaded: Yes",
        "position": 2
      },
      {
        "name": "Connected Information",
        "content": "Device Information:\nCurrent Account Device:\nDevice ID: Device-789\nPrevious Suspended Account:\nDevice ID: Device-789",
        "position": 3
      },
      {
        "name": "Review Activity",
        "content": "Review Content:\n\"The room was clean, the staff was helpful, and the location was convenient.\"",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL information that supports the review being potentially genuine.",
    "options": [
      {
        "letter": "A",
        "text": "Verified booking",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Completed stay",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Original photos",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Device connection with suspended account",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 90,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 3",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q91",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-03",
    "case_title": "CONNECTED TO A SUSPENDED ACCOUNT",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Current Account\nTaylor Smith\nCreated: March 2025\nVerified Email: Yes\nPrevious Reviews: 2\nPrevious Violations: 0",
        "position": 1
      },
      {
        "name": "Booking Information",
        "content": "Booking Status: Completed\nStay Verified: Yes\nPhotos Uploaded: Yes",
        "position": 2
      },
      {
        "name": "Connected Information",
        "content": "Device Information:\nCurrent Account Device:\nDevice ID: Device-789\nPrevious Suspended Account:\nDevice ID: Device-789",
        "position": 3
      },
      {
        "name": "Review Activity",
        "content": "Review Content:\n\"The room was clean, the staff was helpful, and the location was convenient.\"",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is accurate?",
    "options": [
      {
        "letter": "A",
        "text": "A verified booking removes all risk",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "A connected suspended account is a risk indicator that requires consideration",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "New accounts cannot be trusted",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "All connected accounts are fraudulent",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 91,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 3",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q92",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-03",
    "case_title": "CONNECTED TO A SUSPENDED ACCOUNT",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Current Account\nTaylor Smith\nCreated: March 2025\nVerified Email: Yes\nPrevious Reviews: 2\nPrevious Violations: 0",
        "position": 1
      },
      {
        "name": "Booking Information",
        "content": "Booking Status: Completed\nStay Verified: Yes\nPhotos Uploaded: Yes",
        "position": 2
      },
      {
        "name": "Connected Information",
        "content": "Device Information:\nCurrent Account Device:\nDevice ID: Device-789\nPrevious Suspended Account:\nDevice ID: Device-789",
        "position": 3
      },
      {
        "name": "Review Activity",
        "content": "Review Content:\n\"The room was clean, the staff was helpful, and the location was convenient.\"",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What makes this case complex?",
    "options": [
      {
        "letter": "A",
        "text": "The account contains both trust signals and risk indicators",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The account has no review history",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The review has positive feedback",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The account has a verified email",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 92,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 3",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q93",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-04",
    "case_title": "COPIED REVIEW CONTENT PATTERN",
    "tabs": [
      {
        "name": "Review Activity",
        "content": "Property: Green Valley Resort\nAlex Carter Review:\n\"Beautiful property, amazing service, highly recommended.\"\nJordan Lee Review:\n\"Beautiful property, amazing service, highly recommended.\"\nTaylor Smith Review:\n\"Beautiful property, amazing service, highly recommended.\"",
        "position": 1
      },
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: 2 days before review\nPrevious Reviews: 0\nJordan Lee\nCreated: 3 days before review\nPrevious Reviews: 0\nTaylor Smith\nCreated: 1 year before review\nPrevious Reviews: 15",
        "position": 2
      },
      {
        "name": "Connected Information",
        "content": "Alex Carter:\nDevice: Device-111\nJordan Lee:\nDevice: Device-222\nTaylor Smith:\nDevice: Device-333",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which pattern requires attention?",
    "options": [
      {
        "letter": "A",
        "text": "All accounts gave positive ratings",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Multiple accounts used identical review content",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Taylor Smith has previous reviews",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Reviews were posted for the same property",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 93,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 4",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q94",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-04",
    "case_title": "COPIED REVIEW CONTENT PATTERN",
    "tabs": [
      {
        "name": "Review Activity",
        "content": "Property: Green Valley Resort\nAlex Carter Review:\n\"Beautiful property, amazing service, highly recommended.\"\nJordan Lee Review:\n\"Beautiful property, amazing service, highly recommended.\"\nTaylor Smith Review:\n\"Beautiful property, amazing service, highly recommended.\"",
        "position": 1
      },
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: 2 days before review\nPrevious Reviews: 0\nJordan Lee\nCreated: 3 days before review\nPrevious Reviews: 0\nTaylor Smith\nCreated: 1 year before review\nPrevious Reviews: 15",
        "position": 2
      },
      {
        "name": "Connected Information",
        "content": "Alex Carter:\nDevice: Device-111\nJordan Lee:\nDevice: Device-222\nTaylor Smith:\nDevice: Device-333",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL accounts showing higher risk indicators.",
    "options": [
      {
        "letter": "A",
        "text": "Alex Carter",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Jordan Lee",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Taylor Smith",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "None of the accounts",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 94,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 4",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q95",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-04",
    "case_title": "COPIED REVIEW CONTENT PATTERN",
    "tabs": [
      {
        "name": "Review Activity",
        "content": "Property: Green Valley Resort\nAlex Carter Review:\n\"Beautiful property, amazing service, highly recommended.\"\nJordan Lee Review:\n\"Beautiful property, amazing service, highly recommended.\"\nTaylor Smith Review:\n\"Beautiful property, amazing service, highly recommended.\"",
        "position": 1
      },
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: 2 days before review\nPrevious Reviews: 0\nJordan Lee\nCreated: 3 days before review\nPrevious Reviews: 0\nTaylor Smith\nCreated: 1 year before review\nPrevious Reviews: 15",
        "position": 2
      },
      {
        "name": "Connected Information",
        "content": "Alex Carter:\nDevice: Device-111\nJordan Lee:\nDevice: Device-222\nTaylor Smith:\nDevice: Device-333",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Why do Alex Carter and B require closer attention?",
    "options": [
      {
        "letter": "A",
        "text": "They are newly created accounts with no previous activity and identical content",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "They have verified emails",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "They reviewed the same property",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "They gave positive ratings",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 95,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 4",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q96",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-04",
    "case_title": "COPIED REVIEW CONTENT PATTERN",
    "tabs": [
      {
        "name": "Review Activity",
        "content": "Property: Green Valley Resort\nAlex Carter Review:\n\"Beautiful property, amazing service, highly recommended.\"\nJordan Lee Review:\n\"Beautiful property, amazing service, highly recommended.\"\nTaylor Smith Review:\n\"Beautiful property, amazing service, highly recommended.\"",
        "position": 1
      },
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: 2 days before review\nPrevious Reviews: 0\nJordan Lee\nCreated: 3 days before review\nPrevious Reviews: 0\nTaylor Smith\nCreated: 1 year before review\nPrevious Reviews: 15",
        "position": 2
      },
      {
        "name": "Connected Information",
        "content": "Alex Carter:\nDevice: Device-111\nJordan Lee:\nDevice: Device-222\nTaylor Smith:\nDevice: Device-333",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Does identical wording alone confirm fraud?",
    "options": [
      {
        "letter": "A",
        "text": "Yes",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "No, it is a suspicious pattern that requires additional evidence",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Yes, all repeated wording is prohibited",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "No, because review content is irrelevant",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 96,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 4",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q97",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-05",
    "case_title": "SHARED PAYMENT INFORMATION",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nAlex Carterge: 3 Years\nPrevious Reviews: 8\nJordan Lee\nAlex Carterge: 2 Years\nPrevious Reviews: 5",
        "position": 1
      },
      {
        "name": "Booking Information",
        "content": "Alex Carter\nBooking Completed: Yes\nPayment Method Ending: 7821\nJordan Lee\nBooking Completed: Yes\nPayment Method Ending: 7821",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Alex Carter:\nReviewed: Beach Resort\nReview Date: 10 August 2025\nJordan Lee:\nReviewed: Beach Resort\nReview Date: 11 August 2025",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail requires attention?",
    "options": [
      {
        "letter": "A",
        "text": "Both accounts completed bookings",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Both accounts share the same payment information and reviewed the same property within a short period",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Both accounts have previous reviews",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Reviews were posted on different days",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 97,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 5",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q98",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-05",
    "case_title": "SHARED PAYMENT INFORMATION",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nAlex Carterge: 3 Years\nPrevious Reviews: 8\nJordan Lee\nAlex Carterge: 2 Years\nPrevious Reviews: 5",
        "position": 1
      },
      {
        "name": "Booking Information",
        "content": "Alex Carter\nBooking Completed: Yes\nPayment Method Ending: 7821\nJordan Lee\nBooking Completed: Yes\nPayment Method Ending: 7821",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Alex Carter:\nReviewed: Beach Resort\nReview Date: 10 August 2025\nJordan Lee:\nReviewed: Beach Resort\nReview Date: 11 August 2025",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that may indicate a connection between accounts.",
    "options": [
      {
        "letter": "A",
        "text": "Shared payment information",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Same property reviewed",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Similar review timing",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Different account ages",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 98,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 5",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q99",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-05",
    "case_title": "SHARED PAYMENT INFORMATION",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nAlex Carterge: 3 Years\nPrevious Reviews: 8\nJordan Lee\nAlex Carterge: 2 Years\nPrevious Reviews: 5",
        "position": 1
      },
      {
        "name": "Booking Information",
        "content": "Alex Carter\nBooking Completed: Yes\nPayment Method Ending: 7821\nJordan Lee\nBooking Completed: Yes\nPayment Method Ending: 7821",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Alex Carter:\nReviewed: Beach Resort\nReview Date: 10 August 2025\nJordan Lee:\nReviewed: Beach Resort\nReview Date: 11 August 2025",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Does shared payment information automatically confirm fraud?",
    "options": [
      {
        "letter": "A",
        "text": "Yes",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "No, it may indicate a connection but requires additional context",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Yes, because users cannot share payment methods",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "No, because account information is never relevant",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 99,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 5",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q100",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-05",
    "case_title": "SHARED PAYMENT INFORMATION",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nAlex Carterge: 3 Years\nPrevious Reviews: 8\nJordan Lee\nAlex Carterge: 2 Years\nPrevious Reviews: 5",
        "position": 1
      },
      {
        "name": "Booking Information",
        "content": "Alex Carter\nBooking Completed: Yes\nPayment Method Ending: 7821\nJordan Lee\nBooking Completed: Yes\nPayment Method Ending: 7821",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Alex Carter:\nReviewed: Beach Resort\nReview Date: 10 August 2025\nJordan Lee:\nReviewed: Beach Resort\nReview Date: 11 August 2025",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement best describes this case?",
    "options": [
      {
        "letter": "A",
        "text": "The accounts show possible linkage through payment and activity patterns",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The accounts are confirmed fraudulent",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The reviews must be genuine because bookings were completed",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Payment information is unrelated to account behaviour",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 100,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 5",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q101",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-06",
    "case_title": "PROFILE CHANGES BEFORE REVIEW ACTIVITY",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Maria Thomas\nAlex Carterge: 5 Years\nPrevious Reviews: 2\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Alex Carterctivity History",
        "content": "Previous Activity:\nNo reviews posted in the last 3 years\nRecent Changes:\nEmail updated: 5 December 2025\nName updated: 5 December 2025\nProfile picture updated: 5 December 2025",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "New Review:\nPosted: 6 December 2025\nRating: 1 Star\nReview Content:\n\"The property experience was terrible and completely unacceptable.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which activity pattern requires attention?",
    "options": [
      {
        "letter": "A",
        "text": "The account has existed for five years",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Multiple profile changes followed by sudden review activity after a long period of inactivity",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The review has a low rating",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The account has a profile picture",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 101,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 6",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q102",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-06",
    "case_title": "PROFILE CHANGES BEFORE REVIEW ACTIVITY",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Maria Thomas\nAlex Carterge: 5 Years\nPrevious Reviews: 2\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Alex Carterctivity History",
        "content": "Previous Activity:\nNo reviews posted in the last 3 years\nRecent Changes:\nEmail updated: 5 December 2025\nName updated: 5 December 2025\nProfile picture updated: 5 December 2025",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "New Review:\nPosted: 6 December 2025\nRating: 1 Star\nReview Content:\n\"The property experience was terrible and completely unacceptable.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that represent unusual activity.",
    "options": [
      {
        "letter": "A",
        "text": "Long inactive period before posting a review",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Multiple account information changes before review activity",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Account age of five years",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Negative feedback alone",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 102,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 6",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q103",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-06",
    "case_title": "PROFILE CHANGES BEFORE REVIEW ACTIVITY",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Maria Thomas\nAlex Carterge: 5 Years\nPrevious Reviews: 2\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Alex Carterctivity History",
        "content": "Previous Activity:\nNo reviews posted in the last 3 years\nRecent Changes:\nEmail updated: 5 December 2025\nName updated: 5 December 2025\nProfile picture updated: 5 December 2025",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "New Review:\nPosted: 6 December 2025\nRating: 1 Star\nReview Content:\n\"The property experience was terrible and completely unacceptable.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Does changing account information confirm suspicious behaviour?",
    "options": [
      {
        "letter": "A",
        "text": "Yes, all profile changes indicate fraud",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "No, changes can be legitimate but may require additional context",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Yes, because users cannot update details",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "No, because account activity is never relevant",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 103,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 6",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q104",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-06",
    "case_title": "PROFILE CHANGES BEFORE REVIEW ACTIVITY",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Maria Thomas\nAlex Carterge: 5 Years\nPrevious Reviews: 2\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Alex Carterctivity History",
        "content": "Previous Activity:\nNo reviews posted in the last 3 years\nRecent Changes:\nEmail updated: 5 December 2025\nName updated: 5 December 2025\nProfile picture updated: 5 December 2025",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "New Review:\nPosted: 6 December 2025\nRating: 1 Star\nReview Content:\n\"The property experience was terrible and completely unacceptable.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which combination creates the main risk indicator?",
    "options": [
      {
        "letter": "A",
        "text": "Old account + negative review",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Profile changes + sudden activity after inactivity",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Profile picture update + account age",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Low rating + completed review",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 104,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 6",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q105",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-07",
    "case_title": "MULTIPLE ACCOUNTS FROM SAME LOCATION",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: January 2025\nPrevious Reviews: 0\nJordan Lee\nCreated: January 2025\nPrevious Reviews: 0\nTaylor Smith\nCreated: January 2025\nPrevious Reviews: 1",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "All Accounts:\nLocation: Same IP Location\nDevice Information: Different devices",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All Accounts:\nReviewed: Mountain Escape Resort\nReview Date: 15 January 2025\nRating: 5 Stars",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which pattern requires attention?",
    "options": [
      {
        "letter": "A",
        "text": "Different devices were used",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Multiple newly created accounts from the same location reviewed the same property around the same time",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "All reviews have positive ratings",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Accounts have different review counts",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 105,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 7",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q106",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-07",
    "case_title": "MULTIPLE ACCOUNTS FROM SAME LOCATION",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: January 2025\nPrevious Reviews: 0\nJordan Lee\nCreated: January 2025\nPrevious Reviews: 0\nTaylor Smith\nCreated: January 2025\nPrevious Reviews: 1",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "All Accounts:\nLocation: Same IP Location\nDevice Information: Different devices",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All Accounts:\nReviewed: Mountain Escape Resort\nReview Date: 15 January 2025\nRating: 5 Stars",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL indicators that contribute to the risk assessment.",
    "options": [
      {
        "letter": "A",
        "text": "Accounts created within the same month",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Same IP location",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Same property reviewed",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Different devices used",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 106,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 7",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q107",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-07",
    "case_title": "MULTIPLE ACCOUNTS FROM SAME LOCATION",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: January 2025\nPrevious Reviews: 0\nJordan Lee\nCreated: January 2025\nPrevious Reviews: 0\nTaylor Smith\nCreated: January 2025\nPrevious Reviews: 1",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "All Accounts:\nLocation: Same IP Location\nDevice Information: Different devices",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All Accounts:\nReviewed: Mountain Escape Resort\nReview Date: 15 January 2025\nRating: 5 Stars",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Does using different devices eliminate the possibility of connected activity?",
    "options": [
      {
        "letter": "A",
        "text": "Yes",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "No, other indicators may still show a connection pattern",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Yes, because devices are the only connection method",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "No, because all accounts are automatically linked",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 107,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 7",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q108",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-07",
    "case_title": "MULTIPLE ACCOUNTS FROM SAME LOCATION",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: January 2025\nPrevious Reviews: 0\nJordan Lee\nCreated: January 2025\nPrevious Reviews: 0\nTaylor Smith\nCreated: January 2025\nPrevious Reviews: 1",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "All Accounts:\nLocation: Same IP Location\nDevice Information: Different devices",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All Accounts:\nReviewed: Mountain Escape Resort\nReview Date: 15 January 2025\nRating: 5 Stars",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement best describes the activity?",
    "options": [
      {
        "letter": "A",
        "text": "The accounts show multiple overlapping indicators requiring review",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The activity is confirmed fraudulent",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The accounts are genuine because devices differ",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Positive reviews cannot be suspicious",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 108,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 7",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q109",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-08",
    "case_title": "TRUSTED ACCOUNT WITH UNUSUAL BEHAVIOUR",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: John Parker\nAlex Carterge: 8 Years\nPrevious Reviews: 50\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Historical Pattern:\nAverage activity: 5–7 reviews per year\nRecent Activity:\n15 reviews posted within 3 days",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Recent Reviews:\nAll rated 5 Stars\nSimilar sentence structure\nReviewed different properties\nExamples:\n\"Excellent experience, highly recommended.\"\n\"Amazing experience, highly recommended.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which behaviour requires attention?",
    "options": [
      {
        "letter": "A",
        "text": "The account has existed for eight years",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "A trusted account suddenly changed its normal review pattern",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The account has previous reviews",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The reviews are positive",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 109,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 8",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q110",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-08",
    "case_title": "TRUSTED ACCOUNT WITH UNUSUAL BEHAVIOUR",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: John Parker\nAlex Carterge: 8 Years\nPrevious Reviews: 50\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Historical Pattern:\nAverage activity: 5–7 reviews per year\nRecent Activity:\n15 reviews posted within 3 days",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Recent Reviews:\nAll rated 5 Stars\nSimilar sentence structure\nReviewed different properties\nExamples:\n\"Excellent experience, highly recommended.\"\n\"Amazing experience, highly recommended.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL indicators that may require further review.",
    "options": [
      {
        "letter": "A",
        "text": "Sudden increase in review frequency",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similar wording across multiple reviews",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Account age",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Positive ratings alone",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 110,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 8",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q111",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-08",
    "case_title": "TRUSTED ACCOUNT WITH UNUSUAL BEHAVIOUR",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: John Parker\nAlex Carterge: 8 Years\nPrevious Reviews: 50\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Historical Pattern:\nAverage activity: 5–7 reviews per year\nRecent Activity:\n15 reviews posted within 3 days",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Recent Reviews:\nAll rated 5 Stars\nSimilar sentence structure\nReviewed different properties\nExamples:\n\"Excellent experience, highly recommended.\"\n\"Amazing experience, highly recommended.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is correct?",
    "options": [
      {
        "letter": "A",
        "text": "Old accounts cannot engage in suspicious behaviour",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Account history is useful, but unusual recent activity should still be evaluated",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Positive reviews are always genuine",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Long-term users are automatically trusted",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 111,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 8",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q112",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-08",
    "case_title": "TRUSTED ACCOUNT WITH UNUSUAL BEHAVIOUR",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: John Parker\nAlex Carterge: 8 Years\nPrevious Reviews: 50\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Historical Pattern:\nAverage activity: 5–7 reviews per year\nRecent Activity:\n15 reviews posted within 3 days",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Recent Reviews:\nAll rated 5 Stars\nSimilar sentence structure\nReviewed different properties\nExamples:\n\"Excellent experience, highly recommended.\"\n\"Amazing experience, highly recommended.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What makes this case complex?",
    "options": [
      {
        "letter": "A",
        "text": "The account has both trust indicators and unusual behaviour indicators",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The account has no previous history",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The account has no reviews",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The reviews contain negative feedback",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 112,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 8",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q113",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-09",
    "case_title": "MULTIPLE REPORTS AGAINST ONE ACCOUNT",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Emily Davis\nAlex Carterge: 6 Years\nPrevious Reviews: 35\nPrevious Reports: 3 property reports",
        "position": 1
      },
      {
        "name": "Review Activity",
        "content": "Current Review:\nRating:\n4 Stars\nContent:\n\"The room was comfortable, and the location was convenient. Staff were helpful.\"\nAdditional Information:\nVerified booking\nPhotos attached",
        "position": 2
      },
      {
        "name": "Report History",
        "content": "Reports Received:\nReport 1:\n\"This review is unfair.\"\nReport 2:\n\"The rating damages our reputation.\"\nReport 3:\n\"We disagree with this feedback.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which information supports the review being potentially genuine?",
    "options": [
      {
        "letter": "A",
        "text": "Verified booking",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Photos attached",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Specific experience details",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Property disagreement with the review",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 113,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 9",
      "number": 1
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q114",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-09",
    "case_title": "MULTIPLE REPORTS AGAINST ONE ACCOUNT",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Emily Davis\nAlex Carterge: 6 Years\nPrevious Reviews: 35\nPrevious Reports: 3 property reports",
        "position": 1
      },
      {
        "name": "Review Activity",
        "content": "Current Review:\nRating:\n4 Stars\nContent:\n\"The room was comfortable, and the location was convenient. Staff were helpful.\"\nAdditional Information:\nVerified booking\nPhotos attached",
        "position": 2
      },
      {
        "name": "Report History",
        "content": "Reports Received:\nReport 1:\n\"This review is unfair.\"\nReport 2:\n\"The rating damages our reputation.\"\nReport 3:\n\"We disagree with this feedback.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Do reports from the property alone confirm fraudulent activity?",
    "options": [
      {
        "letter": "A",
        "text": "Yes",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "No, reports indicate concern but do not prove fraud",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Yes, multiple reports always confirm violations",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "No, because reports should always be ignored",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 114,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 9",
      "number": 2
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q115",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-09",
    "case_title": "MULTIPLE REPORTS AGAINST ONE ACCOUNT",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Emily Davis\nAlex Carterge: 6 Years\nPrevious Reviews: 35\nPrevious Reports: 3 property reports",
        "position": 1
      },
      {
        "name": "Review Activity",
        "content": "Current Review:\nRating:\n4 Stars\nContent:\n\"The room was comfortable, and the location was convenient. Staff were helpful.\"\nAdditional Information:\nVerified booking\nPhotos attached",
        "position": 2
      },
      {
        "name": "Report History",
        "content": "Reports Received:\nReport 1:\n\"This review is unfair.\"\nReport 2:\n\"The rating damages our reputation.\"\nReport 3:\n\"We disagree with this feedback.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which details should be considered together?",
    "options": [
      {
        "letter": "A",
        "text": "Review content, booking information, and account history",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Number of property complaints only",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Review rating only",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Property opinion only",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 115,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 9",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q116",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-09",
    "case_title": "MULTIPLE REPORTS AGAINST ONE ACCOUNT",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Emily Davis\nAlex Carterge: 6 Years\nPrevious Reviews: 35\nPrevious Reports: 3 property reports",
        "position": 1
      },
      {
        "name": "Review Activity",
        "content": "Current Review:\nRating:\n4 Stars\nContent:\n\"The room was comfortable, and the location was convenient. Staff were helpful.\"\nAdditional Information:\nVerified booking\nPhotos attached",
        "position": 2
      },
      {
        "name": "Report History",
        "content": "Reports Received:\nReport 1:\n\"This review is unfair.\"\nReport 2:\n\"The rating damages our reputation.\"\nReport 3:\n\"We disagree with this feedback.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement best describes this account?",
    "options": [
      {
        "letter": "A",
        "text": "The account has risk indicators but also supporting credibility signals",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The account is confirmed fraudulent",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The account should be ignored because it is old",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The review must be removed because it was reported",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 116,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 9",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q117",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-10",
    "case_title": "COORDINATED REVIEW CAMPAIGN",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Five Accounts:",
        "position": 1
      },
      {
        "name": "Review Activity",
        "content": "All five accounts:\nReviewed: Grand Palace Hotel\nPosted reviews within 30 minutes\nRating: 5 Stars\nSimilar wording used",
        "position": 2
      },
      {
        "name": "Connected Information",
        "content": "Account Details:\nDifferent names\nDifferent email addresses\nSame device type\nSame location pattern",
        "position": 3
      }
    ],
    "tables": [
      {
        "caption": "Account Profile",
        "headers": [
          "Account",
          "Created"
        ],
        "rows": [
          [
            "A",
            "2 January 2026"
          ],
          [
            "B",
            "3 January 2026"
          ],
          [
            "C",
            "5 January 2026"
          ],
          [
            "D",
            "6 January 2026"
          ],
          [
            "E",
            "7 January 2026"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_single",
    "stem": "Which combination creates the strongest risk signal?",
    "options": [
      {
        "letter": "A",
        "text": "Different names and emails",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Multiple new accounts with coordinated timing and similar review behaviour",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Five-star ratings",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Different account names",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 117,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 10",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q118",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-10",
    "case_title": "COORDINATED REVIEW CAMPAIGN",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Five Accounts:",
        "position": 1
      },
      {
        "name": "Review Activity",
        "content": "All five accounts:\nReviewed: Grand Palace Hotel\nPosted reviews within 30 minutes\nRating: 5 Stars\nSimilar wording used",
        "position": 2
      },
      {
        "name": "Connected Information",
        "content": "Account Details:\nDifferent names\nDifferent email addresses\nSame device type\nSame location pattern",
        "position": 3
      }
    ],
    "tables": [
      {
        "caption": "Account Profile",
        "headers": [
          "Account",
          "Created"
        ],
        "rows": [
          [
            "A",
            "2 January 2026"
          ],
          [
            "B",
            "3 January 2026"
          ],
          [
            "C",
            "5 January 2026"
          ],
          [
            "D",
            "6 January 2026"
          ],
          [
            "E",
            "7 January 2026"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_multi",
    "stem": "Select ALL suspicious indicators.",
    "options": [
      {
        "letter": "A",
        "text": "Accounts created within a short timeframe",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Reviews posted within 30 minutes",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Similar wording across reviews",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Different email addresses",
        "is_correct": true
      }
    ],
    "model_answer": null,
    "position": 118,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 10",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q119",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-10",
    "case_title": "COORDINATED REVIEW CAMPAIGN",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Five Accounts:",
        "position": 1
      },
      {
        "name": "Review Activity",
        "content": "All five accounts:\nReviewed: Grand Palace Hotel\nPosted reviews within 30 minutes\nRating: 5 Stars\nSimilar wording used",
        "position": 2
      },
      {
        "name": "Connected Information",
        "content": "Account Details:\nDifferent names\nDifferent email addresses\nSame device type\nSame location pattern",
        "position": 3
      }
    ],
    "tables": [
      {
        "caption": "Account Profile",
        "headers": [
          "Account",
          "Created"
        ],
        "rows": [
          [
            "A",
            "2 January 2026"
          ],
          [
            "B",
            "3 January 2026"
          ],
          [
            "C",
            "5 January 2026"
          ],
          [
            "D",
            "6 January 2026"
          ],
          [
            "E",
            "7 January 2026"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_single",
    "stem": "Does having different names and emails eliminate the possibility of coordinated activity?",
    "options": [
      {
        "letter": "A",
        "text": "Yes",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "No, other behavioural patterns may still indicate a connection",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Yes, because identity information is the only factor",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "No, because all accounts are automatically connected",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 119,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 10",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q120",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-10",
    "case_title": "COORDINATED REVIEW CAMPAIGN",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Five Accounts:",
        "position": 1
      },
      {
        "name": "Review Activity",
        "content": "All five accounts:\nReviewed: Grand Palace Hotel\nPosted reviews within 30 minutes\nRating: 5 Stars\nSimilar wording used",
        "position": 2
      },
      {
        "name": "Connected Information",
        "content": "Account Details:\nDifferent names\nDifferent email addresses\nSame device type\nSame location pattern",
        "position": 3
      }
    ],
    "tables": [
      {
        "caption": "Account Profile",
        "headers": [
          "Account",
          "Created"
        ],
        "rows": [
          [
            "A",
            "2 January 2026"
          ],
          [
            "B",
            "3 January 2026"
          ],
          [
            "C",
            "5 January 2026"
          ],
          [
            "D",
            "6 January 2026"
          ],
          [
            "E",
            "7 January 2026"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_single",
    "stem": "Which statement best describes the activity?",
    "options": [
      {
        "letter": "A",
        "text": "Multiple indicators suggest coordinated account behaviour",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The reviews are confirmed fake",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Positive reviews cannot be suspicious",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "New accounts are always fraudulent",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 120,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 10",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q121",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-11",
    "case_title": "SHARED CONTACT INFORMATION ACROSS ACCOUNTS",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nTaylor Smith\nCreated: February 2025\nPrevious Reviews: 3\nVerified Email: Yes\nJordan Lee\nTaylor Smith\nCreated: March 2025\nPrevious Reviews: 2\nVerified Email: Yes\nTaylor Smith\nTaylor Smith\nCreated: 2022\nPrevious Reviews: 40\nVerified Email: Yes",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Alex Carter:\nRegistered Phone Number: +91 XXXXX1234\nJordan Lee:\nRegistered Phone Number: +91 XXXXX1234\nTaylor Smith:\nRegistered Phone Number: +91 XXXXX9876",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Alex Carter:\nReviewed: Ocean Breeze Hotel\nRating: 5 Stars\nDate: 20 March 2025\nJordan Lee:\nReviewed: Ocean Breeze Hotel\nRating: 5 Stars\nDate: 20 March 2025\nTaylor Smith:\nReviewed: City Inn Hotel\nRating: 4 Stars",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail creates a potential connection between accounts?",
    "options": [
      {
        "letter": "A",
        "text": "Taylor Smith has more reviews",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Alex Carter and B share the same registered phone number and reviewed the same property on the same date",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Alex Carter has fewer reviews",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "All accounts have verified emails",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 121,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 11",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q122",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-11",
    "case_title": "SHARED CONTACT INFORMATION ACROSS ACCOUNTS",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nTaylor Smith\nCreated: February 2025\nPrevious Reviews: 3\nVerified Email: Yes\nJordan Lee\nTaylor Smith\nCreated: March 2025\nPrevious Reviews: 2\nVerified Email: Yes\nTaylor Smith\nTaylor Smith\nCreated: 2022\nPrevious Reviews: 40\nVerified Email: Yes",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Alex Carter:\nRegistered Phone Number: +91 XXXXX1234\nJordan Lee:\nRegistered Phone Number: +91 XXXXX1234\nTaylor Smith:\nRegistered Phone Number: +91 XXXXX9876",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Alex Carter:\nReviewed: Ocean Breeze Hotel\nRating: 5 Stars\nDate: 20 March 2025\nJordan Lee:\nReviewed: Ocean Breeze Hotel\nRating: 5 Stars\nDate: 20 March 2025\nTaylor Smith:\nReviewed: City Inn Hotel\nRating: 4 Stars",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL indicators that require attention.",
    "options": [
      {
        "letter": "A",
        "text": "Shared contact information",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Same property reviewed by connected accounts",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Same review timing",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Different account ages",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 122,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 11",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q123",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-11",
    "case_title": "SHARED CONTACT INFORMATION ACROSS ACCOUNTS",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nTaylor Smith\nCreated: February 2025\nPrevious Reviews: 3\nVerified Email: Yes\nJordan Lee\nTaylor Smith\nCreated: March 2025\nPrevious Reviews: 2\nVerified Email: Yes\nTaylor Smith\nTaylor Smith\nCreated: 2022\nPrevious Reviews: 40\nVerified Email: Yes",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Alex Carter:\nRegistered Phone Number: +91 XXXXX1234\nJordan Lee:\nRegistered Phone Number: +91 XXXXX1234\nTaylor Smith:\nRegistered Phone Number: +91 XXXXX9876",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Alex Carter:\nReviewed: Ocean Breeze Hotel\nRating: 5 Stars\nDate: 20 March 2025\nJordan Lee:\nReviewed: Ocean Breeze Hotel\nRating: 5 Stars\nDate: 20 March 2025\nTaylor Smith:\nReviewed: City Inn Hotel\nRating: 4 Stars",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Does shared contact information alone confirm fraudulent behaviour?",
    "options": [
      {
        "letter": "A",
        "text": "Yes",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "No, it is a connection indicator that requires additional context",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Yes, accounts cannot share contact details",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "No, because contact details are irrelevant",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 123,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 11",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q124",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-11",
    "case_title": "SHARED CONTACT INFORMATION ACROSS ACCOUNTS",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nTaylor Smith\nCreated: February 2025\nPrevious Reviews: 3\nVerified Email: Yes\nJordan Lee\nTaylor Smith\nCreated: March 2025\nPrevious Reviews: 2\nVerified Email: Yes\nTaylor Smith\nTaylor Smith\nCreated: 2022\nPrevious Reviews: 40\nVerified Email: Yes",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Alex Carter:\nRegistered Phone Number: +91 XXXXX1234\nJordan Lee:\nRegistered Phone Number: +91 XXXXX1234\nTaylor Smith:\nRegistered Phone Number: +91 XXXXX9876",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Alex Carter:\nReviewed: Ocean Breeze Hotel\nRating: 5 Stars\nDate: 20 March 2025\nJordan Lee:\nReviewed: Ocean Breeze Hotel\nRating: 5 Stars\nDate: 20 March 2025\nTaylor Smith:\nReviewed: City Inn Hotel\nRating: 4 Stars",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement best describes this activity?",
    "options": [
      {
        "letter": "A",
        "text": "Alex Carter and B show possible linkage through multiple data points",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "All accounts are confirmed fraudulent",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Taylor Smith is the highest risk because it has more reviews",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Verified emails eliminate all risks",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 124,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 11",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q125",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-12",
    "case_title": "DORMANT ACCOUNT REACTIVATION",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Daniel Roberts\nTaylor Smith\nCreated: 2018\nPrevious Reviews: 12\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Historical Activity:\nLast review posted: 2021\nRecent Activity:\nLogged in after 4 years of inactivity\nPosted 10 reviews within 2 days",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Recent Reviews:\nAll rated 5 Stars\nAll posted for newly opened properties\nSimilar sentence structure\nExample:\n\"Great place, excellent service, highly recommended.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which behaviour requires attention?",
    "options": [
      {
        "letter": "A",
        "text": "The account is old",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "A dormant account suddenly became highly active with similar reviews",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The account has previous reviews",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The reviews have positive ratings",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 125,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 12",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q126",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-12",
    "case_title": "DORMANT ACCOUNT REACTIVATION",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Daniel Roberts\nTaylor Smith\nCreated: 2018\nPrevious Reviews: 12\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Historical Activity:\nLast review posted: 2021\nRecent Activity:\nLogged in after 4 years of inactivity\nPosted 10 reviews within 2 days",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Recent Reviews:\nAll rated 5 Stars\nAll posted for newly opened properties\nSimilar sentence structure\nExample:\n\"Great place, excellent service, highly recommended.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL unusual activity patterns.",
    "options": [
      {
        "letter": "A",
        "text": "Long inactivity followed by sudden activity",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "High volume of reviews in a short period",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Similar wording across reviews",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Account creation in 2018",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 126,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 12",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q127",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-12",
    "case_title": "DORMANT ACCOUNT REACTIVATION",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Daniel Roberts\nTaylor Smith\nCreated: 2018\nPrevious Reviews: 12\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Historical Activity:\nLast review posted: 2021\nRecent Activity:\nLogged in after 4 years of inactivity\nPosted 10 reviews within 2 days",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Recent Reviews:\nAll rated 5 Stars\nAll posted for newly opened properties\nSimilar sentence structure\nExample:\n\"Great place, excellent service, highly recommended.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is accurate?",
    "options": [
      {
        "letter": "A",
        "text": "Old accounts cannot show suspicious behaviour",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "A sudden behavioural change may indicate a risk signal requiring review",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Positive reviews are always genuine",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Account age determines trust completely",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 127,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 12",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q128",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-12",
    "case_title": "DORMANT ACCOUNT REACTIVATION",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Daniel Roberts\nTaylor Smith\nCreated: 2018\nPrevious Reviews: 12\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Historical Activity:\nLast review posted: 2021\nRecent Activity:\nLogged in after 4 years of inactivity\nPosted 10 reviews within 2 days",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Recent Reviews:\nAll rated 5 Stars\nAll posted for newly opened properties\nSimilar sentence structure\nExample:\n\"Great place, excellent service, highly recommended.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What makes this case notable?",
    "options": [
      {
        "letter": "A",
        "text": "The current activity differs significantly from historical behaviour",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The account has existed for many years",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The reviews are positive",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The properties are newly opened",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 128,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 12",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q129",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-13",
    "case_title": "MULTIPLE ACCOUNTS INTERACTING WITH SAME PROPERTIES",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: April 2025\nPrevious Reviews: 2\nJordan Lee\nCreated: April 2025\nPrevious Reviews: 1\nTaylor Smith\nCreated: April 2025\nPrevious Reviews: 3",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Within one week:\nAlex Carter:\nReviewed Property X and Property Y\nJordan Lee:\nReviewed Property X and Property Y\nTaylor Smith:\nReviewed Property X and Property Y",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All accounts:\nGave 5-star ratings\nUsed similar positive language",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which pattern requires attention?",
    "options": [
      {
        "letter": "A",
        "text": "Accounts reviewed multiple properties independently",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Newly created accounts repeatedly interacting with the same group of properties",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Accounts gave positive ratings",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Accounts have different review counts",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 129,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 13",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q130",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-13",
    "case_title": "MULTIPLE ACCOUNTS INTERACTING WITH SAME PROPERTIES",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: April 2025\nPrevious Reviews: 2\nJordan Lee\nCreated: April 2025\nPrevious Reviews: 1\nTaylor Smith\nCreated: April 2025\nPrevious Reviews: 3",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Within one week:\nAlex Carter:\nReviewed Property X and Property Y\nJordan Lee:\nReviewed Property X and Property Y\nTaylor Smith:\nReviewed Property X and Property Y",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All accounts:\nGave 5-star ratings\nUsed similar positive language",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL indicators showing similarity between accounts.",
    "options": [
      {
        "letter": "A",
        "text": "Same properties reviewed",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similar rating patterns",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Similar account creation period",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Different review counts",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 130,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 13",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q131",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-13",
    "case_title": "MULTIPLE ACCOUNTS INTERACTING WITH SAME PROPERTIES",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: April 2025\nPrevious Reviews: 2\nJordan Lee\nCreated: April 2025\nPrevious Reviews: 1\nTaylor Smith\nCreated: April 2025\nPrevious Reviews: 3",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Within one week:\nAlex Carter:\nReviewed Property X and Property Y\nJordan Lee:\nReviewed Property X and Property Y\nTaylor Smith:\nReviewed Property X and Property Y",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All accounts:\nGave 5-star ratings\nUsed similar positive language",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Does reviewing the same properties automatically confirm coordinated activity?",
    "options": [
      {
        "letter": "A",
        "text": "Yes",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "No, the pattern requires additional evidence before confirmation",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Yes, because users cannot review the same properties",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "No, because account behaviour is irrelevant",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 131,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 13",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q132",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-13",
    "case_title": "MULTIPLE ACCOUNTS INTERACTING WITH SAME PROPERTIES",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: April 2025\nPrevious Reviews: 2\nJordan Lee\nCreated: April 2025\nPrevious Reviews: 1\nTaylor Smith\nCreated: April 2025\nPrevious Reviews: 3",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Within one week:\nAlex Carter:\nReviewed Property X and Property Y\nJordan Lee:\nReviewed Property X and Property Y\nTaylor Smith:\nReviewed Property X and Property Y",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All accounts:\nGave 5-star ratings\nUsed similar positive language",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement best describes the activity?",
    "options": [
      {
        "letter": "A",
        "text": "Multiple overlapping patterns indicate possible coordination",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The accounts are confirmed fraudulent",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Positive reviews cannot indicate risk",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Account creation date is irrelevant",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 132,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 13",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q133",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-14",
    "case_title": "REPEATED RATING BEHAVIOUR ACROSS PROPERTIES",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Sophia Williams\nAlex Carterge: 2 Years\nPrevious Reviews: 25",
        "position": 1
      },
      {
        "name": "Review History",
        "content": "Last 15 Reviews:\nRating: 5 Stars for every property\nPosted across different cities\nPosted within a short period",
        "position": 2
      },
      {
        "name": "Review Content",
        "content": "Examples:\nReview 1:\n\"Amazing place, excellent experience.\"\nReview 2:\n\"Amazing stay, excellent experience.\"\nReview 3:\n\"Amazing service, excellent experience.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which behaviour requires attention?",
    "options": [
      {
        "letter": "A",
        "text": "The account has many reviews",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Consistent ratings and similar wording across multiple reviews may indicate a pattern",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The account reviewed different cities",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The account is two years old",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 133,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 14",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q134",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-14",
    "case_title": "REPEATED RATING BEHAVIOUR ACROSS PROPERTIES",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Sophia Williams\nAlex Carterge: 2 Years\nPrevious Reviews: 25",
        "position": 1
      },
      {
        "name": "Review History",
        "content": "Last 15 Reviews:\nRating: 5 Stars for every property\nPosted across different cities\nPosted within a short period",
        "position": 2
      },
      {
        "name": "Review Content",
        "content": "Examples:\nReview 1:\n\"Amazing place, excellent experience.\"\nReview 2:\n\"Amazing stay, excellent experience.\"\nReview 3:\n\"Amazing service, excellent experience.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL indicators that contribute to the pattern.",
    "options": [
      {
        "letter": "A",
        "text": "Same rating across multiple reviews",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similar wording structure",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Increased activity within a short period",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Different property locations",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 134,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 14",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q135",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-14",
    "case_title": "REPEATED RATING BEHAVIOUR ACROSS PROPERTIES",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Sophia Williams\nAlex Carterge: 2 Years\nPrevious Reviews: 25",
        "position": 1
      },
      {
        "name": "Review History",
        "content": "Last 15 Reviews:\nRating: 5 Stars for every property\nPosted across different cities\nPosted within a short period",
        "position": 2
      },
      {
        "name": "Review Content",
        "content": "Examples:\nReview 1:\n\"Amazing place, excellent experience.\"\nReview 2:\n\"Amazing stay, excellent experience.\"\nReview 3:\n\"Amazing service, excellent experience.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Does giving all five-star ratings confirm fraud?",
    "options": [
      {
        "letter": "A",
        "text": "Yes",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "No, ratings alone are not enough; other indicators must be considered",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Yes, users cannot give consistent ratings",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "No, because all activity is genuine",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 135,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 14",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q136",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-14",
    "case_title": "REPEATED RATING BEHAVIOUR ACROSS PROPERTIES",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Sophia Williams\nAlex Carterge: 2 Years\nPrevious Reviews: 25",
        "position": 1
      },
      {
        "name": "Review History",
        "content": "Last 15 Reviews:\nRating: 5 Stars for every property\nPosted across different cities\nPosted within a short period",
        "position": 2
      },
      {
        "name": "Review Content",
        "content": "Examples:\nReview 1:\n\"Amazing place, excellent experience.\"\nReview 2:\n\"Amazing stay, excellent experience.\"\nReview 3:\n\"Amazing service, excellent experience.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is accurate?",
    "options": [
      {
        "letter": "A",
        "text": "The account shows behavioural patterns that require evaluation",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The account is automatically fraudulent",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Positive reviews should always be removed",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Account age eliminates risk",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 136,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 14",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q137",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-15",
    "case_title": "DEVICE NETWORK CONNECTION PATTERN",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: January 2026\nPrevious Reviews: 0\nJordan Lee\nCreated: January 2026\nPrevious Reviews: 0\nTaylor Smith\nCreated: January 2026\nPrevious Reviews: 0",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Device Activity:\nAlex Carter:\nDevice ID: D-555\nJordan Lee:\nDevice ID: D-555\nTaylor Smith:\nDevice ID: D-555\nLogin Pattern:\nAll accounts accessed within 10 minutes",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All Accounts:\nReviewed: Luxury Beach Resort\nRating: 5 Stars\nPosted reviews within 15 minutes",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which combination creates the strongest risk signal?",
    "options": [
      {
        "letter": "A",
        "text": "Three accounts have five-star ratings",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Multiple newly created accounts using the same device and posting similar activity together",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Accounts have different usernames",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Reviews were posted for a popular property",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 137,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 15",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q138",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-15",
    "case_title": "DEVICE NETWORK CONNECTION PATTERN",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: January 2026\nPrevious Reviews: 0\nJordan Lee\nCreated: January 2026\nPrevious Reviews: 0\nTaylor Smith\nCreated: January 2026\nPrevious Reviews: 0",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Device Activity:\nAlex Carter:\nDevice ID: D-555\nJordan Lee:\nDevice ID: D-555\nTaylor Smith:\nDevice ID: D-555\nLogin Pattern:\nAll accounts accessed within 10 minutes",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All Accounts:\nReviewed: Luxury Beach Resort\nRating: 5 Stars\nPosted reviews within 15 minutes",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL connected indicators.",
    "options": [
      {
        "letter": "A",
        "text": "Same device ID",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Same account creation period",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Similar review timing",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Different account names",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 138,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 15",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q139",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-15",
    "case_title": "DEVICE NETWORK CONNECTION PATTERN",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: January 2026\nPrevious Reviews: 0\nJordan Lee\nCreated: January 2026\nPrevious Reviews: 0\nTaylor Smith\nCreated: January 2026\nPrevious Reviews: 0",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Device Activity:\nAlex Carter:\nDevice ID: D-555\nJordan Lee:\nDevice ID: D-555\nTaylor Smith:\nDevice ID: D-555\nLogin Pattern:\nAll accounts accessed within 10 minutes",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All Accounts:\nReviewed: Luxury Beach Resort\nRating: 5 Stars\nPosted reviews within 15 minutes",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is correct?",
    "options": [
      {
        "letter": "A",
        "text": "Shared device always confirms fraud",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Shared device combined with coordinated behaviour creates a stronger risk indicator",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "New accounts cannot be genuine",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Different usernames remove all risk",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 139,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 15",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q140",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-15",
    "case_title": "DEVICE NETWORK CONNECTION PATTERN",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: January 2026\nPrevious Reviews: 0\nJordan Lee\nCreated: January 2026\nPrevious Reviews: 0\nTaylor Smith\nCreated: January 2026\nPrevious Reviews: 0",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Device Activity:\nAlex Carter:\nDevice ID: D-555\nJordan Lee:\nDevice ID: D-555\nTaylor Smith:\nDevice ID: D-555\nLogin Pattern:\nAll accounts accessed within 10 minutes",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All Accounts:\nReviewed: Luxury Beach Resort\nRating: 5 Stars\nPosted reviews within 15 minutes",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What makes this case different from normal user activity?",
    "options": [
      {
        "letter": "A",
        "text": "Multiple accounts show overlapping behavioural and technical connections",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The property received positive reviews",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Accounts have different usernames",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The reviews mention the same property",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 140,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 15",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q141",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-16",
    "case_title": "UNUSUAL ACTIVITY FROM A VERIFIED ACCOUNT",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Robert Miller\nAlex Carterge: 7 Years\nVerified Email: Yes\nVerified Phone: Yes\nPrevious Reviews: 45\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Historical Pattern:\nAverage reviews per month: 2–3\nRecent Activity:\n25 reviews posted within 7 days",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Recent Reviews:\nAll rated 5 Stars\nPosted across multiple cities\nSimilar sentence structure\nExamples:\nReview 1:\n\"Great experience, wonderful stay, highly recommended.\"\nReview 2:\n\"Great experience, excellent stay, highly recommended.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail creates a potential risk indicator?",
    "options": [
      {
        "letter": "A",
        "text": "The account is verified",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "A significant change from normal review behaviour is observed",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The account has previous reviews",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Reviews are from different cities",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 141,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 16",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q142",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-16",
    "case_title": "UNUSUAL ACTIVITY FROM A VERIFIED ACCOUNT",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Robert Miller\nAlex Carterge: 7 Years\nVerified Email: Yes\nVerified Phone: Yes\nPrevious Reviews: 45\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Historical Pattern:\nAverage reviews per month: 2–3\nRecent Activity:\n25 reviews posted within 7 days",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Recent Reviews:\nAll rated 5 Stars\nPosted across multiple cities\nSimilar sentence structure\nExamples:\nReview 1:\n\"Great experience, wonderful stay, highly recommended.\"\nReview 2:\n\"Great experience, excellent stay, highly recommended.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that indicate unusual behaviour.",
    "options": [
      {
        "letter": "A",
        "text": "Large increase in review volume",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similar wording patterns",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Verified account status",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Account age of seven years",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 142,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 16",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q143",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-16",
    "case_title": "UNUSUAL ACTIVITY FROM A VERIFIED ACCOUNT",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Robert Miller\nAlex Carterge: 7 Years\nVerified Email: Yes\nVerified Phone: Yes\nPrevious Reviews: 45\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Historical Pattern:\nAverage reviews per month: 2–3\nRecent Activity:\n25 reviews posted within 7 days",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Recent Reviews:\nAll rated 5 Stars\nPosted across multiple cities\nSimilar sentence structure\nExamples:\nReview 1:\n\"Great experience, wonderful stay, highly recommended.\"\nReview 2:\n\"Great experience, excellent stay, highly recommended.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Does having a verified and established account remove all risk?",
    "options": [
      {
        "letter": "A",
        "text": "Yes",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "No, unusual behaviour can still occur on trusted accounts",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Yes, because old accounts cannot be misused",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "No, because verified accounts are always fraudulent",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 143,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 16",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q144",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-16",
    "case_title": "UNUSUAL ACTIVITY FROM A VERIFIED ACCOUNT",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Account Name: Robert Miller\nAlex Carterge: 7 Years\nVerified Email: Yes\nVerified Phone: Yes\nPrevious Reviews: 45\nPrevious Reports: 0",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "Historical Pattern:\nAverage reviews per month: 2–3\nRecent Activity:\n25 reviews posted within 7 days",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Recent Reviews:\nAll rated 5 Stars\nPosted across multiple cities\nSimilar sentence structure\nExamples:\nReview 1:\n\"Great experience, wonderful stay, highly recommended.\"\nReview 2:\n\"Great experience, excellent stay, highly recommended.\"",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement best describes this case?",
    "options": [
      {
        "letter": "A",
        "text": "The account has both trust indicators and unusual activity indicators",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The account is confirmed fraudulent",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The reviews are genuine because the account is old",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Positive reviews cannot require analysis",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 144,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 16",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q145",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-17",
    "case_title": "MULTIPLE ACCOUNTS CREATED AROUND THE SAME EVENT",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Taylor Smithreation Details:",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "All accounts:\nFirst activity occurred within 24 hours of account creation\nNo previous history available",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All accounts:\nReviewed: Royal Heritage Hotel\nRating: 5 Stars\nReviews posted within 2 days",
        "position": 3
      }
    ],
    "tables": [
      {
        "caption": "Account Profile",
        "headers": [
          "Account",
          "Created Date"
        ],
        "rows": [
          [
            "Alex Carter",
            "1 June 2026"
          ],
          [
            "Jordan Lee",
            "2 June 2026"
          ],
          [
            "Taylor Smith",
            "3 June 2026"
          ],
          [
            "Account D",
            "5 June 2026"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_single",
    "stem": "Which pattern requires attention?",
    "options": [
      {
        "letter": "A",
        "text": "Accounts are newly created and immediately active around the same property",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Accounts gave positive ratings",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Accounts have different names",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Accounts have no previous reviews",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 145,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 17",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q146",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-17",
    "case_title": "MULTIPLE ACCOUNTS CREATED AROUND THE SAME EVENT",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Taylor Smithreation Details:",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "All accounts:\nFirst activity occurred within 24 hours of account creation\nNo previous history available",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All accounts:\nReviewed: Royal Heritage Hotel\nRating: 5 Stars\nReviews posted within 2 days",
        "position": 3
      }
    ],
    "tables": [
      {
        "caption": "Account Profile",
        "headers": [
          "Account",
          "Created Date"
        ],
        "rows": [
          [
            "Alex Carter",
            "1 June 2026"
          ],
          [
            "Jordan Lee",
            "2 June 2026"
          ],
          [
            "Taylor Smith",
            "3 June 2026"
          ],
          [
            "Account D",
            "5 June 2026"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_multi",
    "stem": "Select ALL indicators that show similar behaviour.",
    "options": [
      {
        "letter": "A",
        "text": "Similar account creation period",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similar first activity timing",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Same property interaction",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Different account names",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 146,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 17",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q147",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-17",
    "case_title": "MULTIPLE ACCOUNTS CREATED AROUND THE SAME EVENT",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Taylor Smithreation Details:",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "All accounts:\nFirst activity occurred within 24 hours of account creation\nNo previous history available",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All accounts:\nReviewed: Royal Heritage Hotel\nRating: 5 Stars\nReviews posted within 2 days",
        "position": 3
      }
    ],
    "tables": [
      {
        "caption": "Account Profile",
        "headers": [
          "Account",
          "Created Date"
        ],
        "rows": [
          [
            "Alex Carter",
            "1 June 2026"
          ],
          [
            "Jordan Lee",
            "2 June 2026"
          ],
          [
            "Taylor Smith",
            "3 June 2026"
          ],
          [
            "Account D",
            "5 June 2026"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_single",
    "stem": "Does creating an account close to another account automatically prove fraud?",
    "options": [
      {
        "letter": "A",
        "text": "Yes",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "No, timing similarity is a risk indicator but requires additional context",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Yes, users cannot create accounts on similar dates",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "No, account activity patterns are irrelevant",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 147,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 17",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q148",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-17",
    "case_title": "MULTIPLE ACCOUNTS CREATED AROUND THE SAME EVENT",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Taylor Smithreation Details:",
        "position": 1
      },
      {
        "name": "Activity History",
        "content": "All accounts:\nFirst activity occurred within 24 hours of account creation\nNo previous history available",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All accounts:\nReviewed: Royal Heritage Hotel\nRating: 5 Stars\nReviews posted within 2 days",
        "position": 3
      }
    ],
    "tables": [
      {
        "caption": "Account Profile",
        "headers": [
          "Account",
          "Created Date"
        ],
        "rows": [
          [
            "Alex Carter",
            "1 June 2026"
          ],
          [
            "Jordan Lee",
            "2 June 2026"
          ],
          [
            "Taylor Smith",
            "3 June 2026"
          ],
          [
            "Account D",
            "5 June 2026"
          ]
        ],
        "position": 1
      }
    ],
    "response_type": "mcq_single",
    "stem": "What makes this activity unusual?",
    "options": [
      {
        "letter": "A",
        "text": "Multiple accounts show similar creation and activity patterns around one property",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The accounts have different usernames",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The reviews are positive",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The accounts have no profile photos",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 148,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 17",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q149",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-18",
    "case_title": "SHARED LOCATION WITH DIFFERENT BEHAVIOUR",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: 2020\nPrevious Reviews: 50\nJordan Lee\nCreated: 2025\nPrevious Reviews: 1",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Location:\nAlex Carter: Delhi, India\nJordan Lee: Delhi, India\nDevice:\nAlex Carter: Device-111\nJordan Lee: Device-222",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Alex Carter:\nReviewed multiple properties over 5 years\nJordan Lee:\nPosted one review for the same property as Alex Carter\nPosted on the same day",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail requires attention?",
    "options": [
      {
        "letter": "A",
        "text": "Both users are located in the same city",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Both accounts reviewed the same property on the same day despite different account histories",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Alex Carter has many reviews",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Jordan Lee is a newer account",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 149,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 18",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q150",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-18",
    "case_title": "SHARED LOCATION WITH DIFFERENT BEHAVIOUR",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: 2020\nPrevious Reviews: 50\nJordan Lee\nCreated: 2025\nPrevious Reviews: 1",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Location:\nAlex Carter: Delhi, India\nJordan Lee: Delhi, India\nDevice:\nAlex Carter: Device-111\nJordan Lee: Device-222",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Alex Carter:\nReviewed multiple properties over 5 years\nJordan Lee:\nPosted one review for the same property as Alex Carter\nPosted on the same day",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL details that should be considered together.",
    "options": [
      {
        "letter": "A",
        "text": "Location information",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Review timing",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Account history differences",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Property rating only",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 150,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 18",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q151",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-18",
    "case_title": "SHARED LOCATION WITH DIFFERENT BEHAVIOUR",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: 2020\nPrevious Reviews: 50\nJordan Lee\nCreated: 2025\nPrevious Reviews: 1",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Location:\nAlex Carter: Delhi, India\nJordan Lee: Delhi, India\nDevice:\nAlex Carter: Device-111\nJordan Lee: Device-222",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Alex Carter:\nReviewed multiple properties over 5 years\nJordan Lee:\nPosted one review for the same property as Alex Carter\nPosted on the same day",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Does sharing the same location confirm that accounts are connected?",
    "options": [
      {
        "letter": "A",
        "text": "Yes",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "No, location alone is not enough evidence of a connection",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Yes, users in the same location cannot be separate",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "No, because location data is never useful",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 151,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 18",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q152",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-18",
    "case_title": "SHARED LOCATION WITH DIFFERENT BEHAVIOUR",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: 2020\nPrevious Reviews: 50\nJordan Lee\nCreated: 2025\nPrevious Reviews: 1",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Location:\nAlex Carter: Delhi, India\nJordan Lee: Delhi, India\nDevice:\nAlex Carter: Device-111\nJordan Lee: Device-222",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "Alex Carter:\nReviewed multiple properties over 5 years\nJordan Lee:\nPosted one review for the same property as Alex Carter\nPosted on the same day",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Why is this case less clear than a shared-device case?",
    "options": [
      {
        "letter": "A",
        "text": "The accounts have only a location similarity and limited overlap indicators",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The accounts have the same device",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The accounts were created together",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The reviews are identical",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 152,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 18",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q153",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-19",
    "case_title": "HIGH-VOLUME ACTIVITY FROM A SINGLE NETWORK",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Five Accounts:\nAll created within one month\nEach account has fewer than two reviews",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Network Information:\nAll accounts accessed from the same network\nDifferent devices used\nDifferent email addresses used",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All accounts:\nReviewed different properties\nPosted reviews within the same hour\nUsed similar rating patterns",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which combination creates a stronger risk signal?",
    "options": [
      {
        "letter": "A",
        "text": "Different emails and different devices",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Multiple low-history accounts showing similar activity from the same network",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Different properties reviewed",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Different usernames",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 153,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 19",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q154",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-19",
    "case_title": "HIGH-VOLUME ACTIVITY FROM A SINGLE NETWORK",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Five Accounts:\nAll created within one month\nEach account has fewer than two reviews",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Network Information:\nAll accounts accessed from the same network\nDifferent devices used\nDifferent email addresses used",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All accounts:\nReviewed different properties\nPosted reviews within the same hour\nUsed similar rating patterns",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL indicators present in this case.",
    "options": [
      {
        "letter": "A",
        "text": "Newly created accounts",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Shared network pattern",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Similar activity timing",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Verified long-term account history",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 154,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 19",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q155",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-19",
    "case_title": "HIGH-VOLUME ACTIVITY FROM A SINGLE NETWORK",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Five Accounts:\nAll created within one month\nEach account has fewer than two reviews",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Network Information:\nAll accounts accessed from the same network\nDifferent devices used\nDifferent email addresses used",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All accounts:\nReviewed different properties\nPosted reviews within the same hour\nUsed similar rating patterns",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Does using different devices eliminate the possibility of coordinated behaviour?",
    "options": [
      {
        "letter": "A",
        "text": "Yes",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "No, other shared patterns may still indicate coordination",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Yes, device is the only possible connection",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "No, all accounts using networks are connected",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 155,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 19",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q156",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-19",
    "case_title": "HIGH-VOLUME ACTIVITY FROM A SINGLE NETWORK",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Five Accounts:\nAll created within one month\nEach account has fewer than two reviews",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Network Information:\nAll accounts accessed from the same network\nDifferent devices used\nDifferent email addresses used",
        "position": 2
      },
      {
        "name": "Review Activity",
        "content": "All accounts:\nReviewed different properties\nPosted reviews within the same hour\nUsed similar rating patterns",
        "position": 3
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement best describes the activity?",
    "options": [
      {
        "letter": "A",
        "text": "Multiple behavioural indicators suggest a possible coordinated pattern",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The accounts are confirmed fraudulent",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Different properties mean the accounts are unrelated",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Different emails eliminate all concerns",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 156,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 19",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q157",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-20",
    "case_title": "COMPLEX MULTI-INDICATOR ACCOUNT PATTERN",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: January 2026\nPrevious Reviews: 0\nJordan Lee\nCreated: January 2026\nPrevious Reviews: 1",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Both accounts use the same device\nBoth accounts use the same payment method\nBoth accounts accessed from the same location",
        "position": 2
      },
      {
        "name": "Activity History",
        "content": "Both accounts:\nReviewed the same three properties\nPosted within minutes of each other\nUsed similar wording",
        "position": 3
      },
      {
        "name": "Account History",
        "content": "Alex Carter:\nNo previous reports\nJordan Lee:\nPreviously linked to a reported account",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Select ALL indicators that contribute to the risk pattern.",
    "options": [
      {
        "letter": "A",
        "text": "Same device usage",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Shared payment information",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Similar review timing and wording",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Previous connection to a reported account",
        "is_correct": true
      }
    ],
    "model_answer": null,
    "position": 157,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 20",
      "number": 1
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "att-level-2-q158",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-20",
    "case_title": "COMPLEX MULTI-INDICATOR ACCOUNT PATTERN",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: January 2026\nPrevious Reviews: 0\nJordan Lee\nCreated: January 2026\nPrevious Reviews: 1",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Both accounts use the same device\nBoth accounts use the same payment method\nBoth accounts accessed from the same location",
        "position": 2
      },
      {
        "name": "Activity History",
        "content": "Both accounts:\nReviewed the same three properties\nPosted within minutes of each other\nUsed similar wording",
        "position": 3
      },
      {
        "name": "Account History",
        "content": "Alex Carter:\nNo previous reports\nJordan Lee:\nPreviously linked to a reported account",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which factor makes this case more complex?",
    "options": [
      {
        "letter": "A",
        "text": "The accounts contain multiple overlapping risk indicators and some account history concerns",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The accounts have different names",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The accounts reviewed multiple properties",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The reviews are positive",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 158,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 20",
      "number": 2
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q159",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-20",
    "case_title": "COMPLEX MULTI-INDICATOR ACCOUNT PATTERN",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: January 2026\nPrevious Reviews: 0\nJordan Lee\nCreated: January 2026\nPrevious Reviews: 1",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Both accounts use the same device\nBoth accounts use the same payment method\nBoth accounts accessed from the same location",
        "position": 2
      },
      {
        "name": "Activity History",
        "content": "Both accounts:\nReviewed the same three properties\nPosted within minutes of each other\nUsed similar wording",
        "position": 3
      },
      {
        "name": "Account History",
        "content": "Alex Carter:\nNo previous reports\nJordan Lee:\nPreviously linked to a reported account",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Does any single indicator alone confirm fraudulent activity?",
    "options": [
      {
        "letter": "A",
        "text": "Yes",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "No, risk assessment should consider the combined evidence",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Yes, shared payment always confirms fraud",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "No, account information is irrelevant",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 159,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 20",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "att-level-2-q160",
    "bank": "attention",
    "section": "level_2",
    "level": "L2",
    "case_id": "attn-l2-case-20",
    "case_title": "COMPLEX MULTI-INDICATOR ACCOUNT PATTERN",
    "tabs": [
      {
        "name": "Account Profile",
        "content": "Alex Carter\nCreated: January 2026\nPrevious Reviews: 0\nJordan Lee\nCreated: January 2026\nPrevious Reviews: 1",
        "position": 1
      },
      {
        "name": "Connected Information",
        "content": "Both accounts use the same device\nBoth accounts use the same payment method\nBoth accounts accessed from the same location",
        "position": 2
      },
      {
        "name": "Activity History",
        "content": "Both accounts:\nReviewed the same three properties\nPosted within minutes of each other\nUsed similar wording",
        "position": 3
      },
      {
        "name": "Account History",
        "content": "Alex Carter:\nNo previous reports\nJordan Lee:\nPreviously linked to a reported account",
        "position": 4
      }
    ],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement best describes this activity?",
    "options": [
      {
        "letter": "A",
        "text": "Multiple technical and behavioural connections suggest a coordinated pattern requiring evaluation",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The accounts are automatically genuine because reviews exist",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Positive reviews cannot be suspicious",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "New accounts are always fraudulent",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 160,
    "source": {
      "file": "FS Question Bank_Attention to Detail V2.docx",
      "section": "LEVEL 2 Case 20",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q01",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-01",
    "case_title": "High-Risk Coordinated Activity",
    "tabs": [
    {
        "name": "Case File",
        "content": "Within one hour, six newly created accounts posted five-star reviews for the same property. The reviews contain very similar wording, were posted from the same IP address, and none are linked to verified bookings. One reviewer has uploaded travel photos and completed profile information",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the biggest risk indicator in this case?",
    "options": [
      {
        "letter": "A",
        "text": "The reviews are positive.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Multiple accounts showing similar activity patterns",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "One reviewer uploaded travel photos.",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The property received multiple reviews.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 1,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 1",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q02",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-01",
    "case_title": "High-Risk Coordinated Activity",
    "tabs": [
    {
        "name": "Case File",
        "content": "Within one hour, six newly created accounts posted five-star reviews for the same property. The reviews contain very similar wording, were posted from the same IP address, and none are linked to verified bookings. One reviewer has uploaded travel photos and completed profile information",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which details increase the possibility of coordinated activity?",
    "options": [
      {
        "letter": "A",
        "text": "Multiple newly created accounts",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similar review wording",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Reviews posted within a short time period",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Same IP address",
        "is_correct": true
      }
    ],
    "model_answer": null,
    "position": 2,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 1",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q03",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-01",
    "case_title": "High-Risk Coordinated Activity",
    "tabs": [
    {
        "name": "Case File",
        "content": "Within one hour, six newly created accounts posted five-star reviews for the same property. The reviews contain very similar wording, were posted from the same IP address, and none are linked to verified bookings. One reviewer has uploaded travel photos and completed profile information",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is NOT supported by the available evidence?",
    "options": [
      {
        "letter": "A",
        "text": "The activity may require further assessment.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Multiple risk indicators are present.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The reviews are definitely fraudulent.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The accounts show unusual similarities.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 3,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 1",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q04",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-01",
    "case_title": "High-Risk Coordinated Activity",
    "tabs": [
    {
        "name": "Case File",
        "content": "Within one hour, six newly created accounts posted five-star reviews for the same property. The reviews contain very similar wording, were posted from the same IP address, and none are linked to verified bookings. One reviewer has uploaded travel photos and completed profile information",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which business decision best balances customer trust and fraud prevention?",
    "options": [
      {
        "letter": "A",
        "text": "Remove all reviews immediately.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Evaluate the evidence further before taking enforcement action.",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Ignore the activity because the reviews are positive.",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Approve the reviews because one account appears complete.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 4,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 1",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q05",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-02",
    "case_title": "Trusted Reviewer with One Reported Issue",
    "tabs": [
    {
        "name": "Case File",
        "content": "A reviewer has an eight-year account history, more than 300 reviews, verified bookings, and no previous violations. A property owner reports one recent review as suspicious. The review includes detailed information about the stay, but two sentences are similar to another review for the same property.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which factor reduces the overall risk in this case?",
    "options": [
      {
        "letter": "A",
        "text": "The review is detailed.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The account has a strong history with verified activity.",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The property owner submitted a report.",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The review contains similar wording.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 5,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 2",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q06",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-02",
    "case_title": "Trusted Reviewer with One Reported Issue",
    "tabs": [
    {
        "name": "Case File",
        "content": "A reviewer has an eight-year account history, more than 300 reviews, verified bookings, and no previous violations. A property owner reports one recent review as suspicious. The review includes detailed information about the stay, but two sentences are similar to another review for the same property.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which factors should be considered when evaluating this case?",
    "options": [
      {
        "letter": "A",
        "text": "The review content",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The account history",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The similarity between reviews",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property's popularity",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 6,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 2",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q07",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-02",
    "case_title": "Trusted Reviewer with One Reported Issue",
    "tabs": [
    {
        "name": "Case File",
        "content": "A reviewer has an eight-year account history, more than 300 reviews, verified bookings, and no previous violations. A property owner reports one recent review as suspicious. The review includes detailed information about the stay, but two sentences are similar to another review for the same property.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which conclusion is most reasonable based on the available evidence?",
    "options": [
      {
        "letter": "A",
        "text": "The review is fraudulent.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The account should be suspended.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The case contains both trustworthy and suspicious indicators.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The report should be ignored.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 7,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 2",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q08",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-02",
    "case_title": "Trusted Reviewer with One Reported Issue",
    "tabs": [
    {
        "name": "Case File",
        "content": "A reviewer has an eight-year account history, more than 300 reviews, verified bookings, and no previous violations. A property owner reports one recent review as suspicious. The review includes detailed information about the stay, but two sentences are similar to another review for the same property.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which assumption should be avoided?",
    "options": [
      {
        "letter": "A",
        "text": "Account history provides useful context.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Similar wording may require evaluation.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Long-term users cannot engage in policy violations.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Decisions should consider multiple factors.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 8,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 2",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q09",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-03",
    "case_title": "Mixed Evidence Review",
    "tabs": [
    {
        "name": "Case File",
        "content": "A review is connected to a verified booking. However, the account was created two days ago, the review is very similar to another review for the same property, and the property owner has reported it as suspicious.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the most balanced assessment of this case?",
    "options": [
      {
        "letter": "A",
        "text": "The review is genuine because there is a verified booking.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The review is fraudulent because the account is new.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The case contains mixed indicators and requires careful evaluation.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "No review is required.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 9,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 3",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q10",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-03",
    "case_title": "Mixed Evidence Review",
    "tabs": [
    {
        "name": "Case File",
        "content": "A review is connected to a verified booking. However, the account was created two days ago, the review is very similar to another review for the same property, and the property owner has reported it as suspicious.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which details increase the level of concern?",
    "options": [
      {
        "letter": "A",
        "text": "Newly created account",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similar review wording",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Report from the property owner",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Verified booking",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 10,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 3",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q11",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-03",
    "case_title": "Mixed Evidence Review",
    "tabs": [
    {
        "name": "Case File",
        "content": "A review is connected to a verified booking. However, the account was created two days ago, the review is very similar to another review for the same property, and the property owner has reported it as suspicious.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is best supported by the evidence?",
    "options": [
      {
        "letter": "A",
        "text": "Verified bookings eliminate all fraud risk.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "New accounts are always suspicious.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "A combination of positive and negative indicators should be considered together.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property owner's complaint confirms fraud.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 11,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 3",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q12",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-03",
    "case_title": "Mixed Evidence Review",
    "tabs": [
    {
        "name": "Case File",
        "content": "A review is connected to a verified booking. However, the account was created two days ago, the review is very similar to another review for the same property, and the property owner has reported it as suspicious.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which decision demonstrates good judgment?",
    "options": [
      {
        "letter": "A",
        "text": "Always remove reviews with suspicious indicators.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Always trust verified bookings.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Consider the complete context before making a final decision.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Prioritize the complaint over all other evidence.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 12,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 3",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q13",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-04",
    "case_title": "Repeat Policy Violation Pattern",
    "tabs": [
    {
        "name": "Case File",
        "content": "An account has received four confirmed policy violations within the last year. A new report has been submitted, and the reported behavior appears similar to previous confirmed violations.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What factor contributes most to the risk assessment?",
    "options": [
      {
        "letter": "A",
        "text": "The account has many activities.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "A repeated pattern of confirmed violations",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The user has an old account.",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The report was submitted recently.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 13,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 4",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q14",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-04",
    "case_title": "Repeat Policy Violation Pattern",
    "tabs": [
    {
        "name": "Case File",
        "content": "An account has received four confirmed policy violations within the last year. A new report has been submitted, and the reported behavior appears similar to previous confirmed violations.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which details are important when evaluating the risk?",
    "options": [
      {
        "letter": "A",
        "text": "Previous confirmed violations",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similarity between past and current behavior",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Account profile information",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Pattern of repeated activity",
        "is_correct": true
      }
    ],
    "model_answer": null,
    "position": 14,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 4",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q15",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-04",
    "case_title": "Repeat Policy Violation Pattern",
    "tabs": [
    {
        "name": "Case File",
        "content": "An account has received four confirmed policy violations within the last year. A new report has been submitted, and the reported behavior appears similar to previous confirmed violations.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is most accurate?",
    "options": [
      {
        "letter": "A",
        "text": "Previous violations automatically prove the new report.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Previous history provides context but the current evidence must also be considered.",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Past violations should never influence decisions.",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "A single report is always enough for enforcement.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 15,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 4",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q16",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-04",
    "case_title": "Repeat Policy Violation Pattern",
    "tabs": [
    {
        "name": "Case File",
        "content": "An account has received four confirmed policy violations within the last year. A new report has been submitted, and the reported behavior appears similar to previous confirmed violations.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the biggest concern if repeated behavior is ignored?",
    "options": [
      {
        "letter": "A",
        "text": "The account may receive more reviews.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "A recurring harmful pattern may continue.",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The user may update their profile.",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The property rating may change.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 16,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 4",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q17",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-05",
    "case_title": "Repeated Property Complaints",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property has received 20 complaints over two months regarding misleading amenities. The complaints come from different travelers, and many describe the same issue. The property owner denies the claims and states that the complaints are incorrect.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What makes this case higher risk?",
    "options": [
      {
        "letter": "A",
        "text": "The property owner disagrees.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The property has received negative feedback.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Multiple customers reported a similar concern over time.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property has many bookings.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 17,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 5",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q18",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-05",
    "case_title": "Repeated Property Complaints",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property has received 20 complaints over two months regarding misleading amenities. The complaints come from different travelers, and many describe the same issue. The property owner denies the claims and states that the complaints are incorrect.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which details strengthen the credibility of the complaints?",
    "options": [
      {
        "letter": "A",
        "text": "Reports from different travelers",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similar concerns mentioned repeatedly",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The issue appears over an extended period",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property has a low rating",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 18,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 5",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q19",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-05",
    "case_title": "Repeated Property Complaints",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property has received 20 complaints over two months regarding misleading amenities. The complaints come from different travelers, and many describe the same issue. The property owner denies the claims and states that the complaints are incorrect.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which conclusion is most reasonable?",
    "options": [
      {
        "letter": "A",
        "text": "The property is definitely misleading customers.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "All complaints should be ignored because the owner disagrees.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "A repeated pattern suggests the concern requires careful evaluation.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "One complaint is enough to confirm misconduct.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 19,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 5",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q20",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-05",
    "case_title": "Repeated Property Complaints",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property has received 20 complaints over two months regarding misleading amenities. The complaints come from different travelers, and many describe the same issue. The property owner denies the claims and states that the complaints are incorrect.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which decision best balances fairness and customer trust?",
    "options": [
      {
        "letter": "A",
        "text": "Remove the property immediately.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Reject the complaints because there is no admission from the owner.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Evaluate the evidence pattern before deciding on further action.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Ignore the complaints because the property is popular.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 20,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 5",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q21",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-06",
    "case_title": "Report Without Supporting Evidence",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property owner reports that a review is fake. The review is linked to a completed booking, but neither the property owner nor the reviewer has provided additional supporting evidence. The reviewer has no previous policy violations.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the most reasonable assessment of this case?",
    "options": [
      {
        "letter": "A",
        "text": "The review is fraudulent because the owner reported it.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The review is genuine because there is a completed booking.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "There is not enough evidence to make a final conclusion.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property owner submitted an invalid report.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 21,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 6",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q22",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-06",
    "case_title": "Report Without Supporting Evidence",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property owner reports that a review is fake. The review is linked to a completed booking, but neither the property owner nor the reviewer has provided additional supporting evidence. The reviewer has no previous policy violations.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which factors should influence the decision?",
    "options": [
      {
        "letter": "A",
        "text": "Available evidence from both parties",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Booking information",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Reviewer's account history",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Property rating",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 22,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 6",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q23",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-06",
    "case_title": "Report Without Supporting Evidence",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property owner reports that a review is fake. The review is linked to a completed booking, but neither the property owner nor the reviewer has provided additional supporting evidence. The reviewer has no previous policy violations.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is NOT supported by the available information?",
    "options": [
      {
        "letter": "A",
        "text": "More information may be needed.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The case requires an evidence-based decision.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The review should be removed because it was reported.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "A report alone does not confirm a violation.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 23,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 6",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q24",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-06",
    "case_title": "Report Without Supporting Evidence",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property owner reports that a review is fake. The review is linked to a completed booking, but neither the property owner nor the reviewer has provided additional supporting evidence. The reviewer has no previous policy violations.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which approach demonstrates good judgment?",
    "options": [
      {
        "letter": "A",
        "text": "Always trust the property owner's claim.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Always prioritize verified bookings.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Consider all available evidence before reaching a decision.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Remove any review that creates concern.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 24,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 6",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q25",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-07",
    "case_title": "Coordinated Activity Across Multiple Accounts",
    "tabs": [
    {
        "name": "Case File",
        "content": "Four different accounts posted reviews for the same group of properties over several weeks. The reviews were posted within minutes of each other and follow a similar structure. Each account uses a different device and has verified bookings.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which factor creates the highest concern in this case?",
    "options": [
      {
        "letter": "A",
        "text": "The accounts use different devices.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The reviews have verified bookings.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The accounts show a repeated pattern of similar activity.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The reviews were posted over several weeks.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 25,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 7",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q26",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-07",
    "case_title": "Coordinated Activity Across Multiple Accounts",
    "tabs": [
    {
        "name": "Case File",
        "content": "Four different accounts posted reviews for the same group of properties over several weeks. The reviews were posted within minutes of each other and follow a similar structure. Each account uses a different device and has verified bookings.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which details may indicate coordinated behavior?",
    "options": [
      {
        "letter": "A",
        "text": "Similar review patterns",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Reviews posted within a short time period",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Multiple accounts interacting with the same properties",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Different devices being used",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 26,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 7",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q27",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-07",
    "case_title": "Coordinated Activity Across Multiple Accounts",
    "tabs": [
    {
        "name": "Case File",
        "content": "Four different accounts posted reviews for the same group of properties over several weeks. The reviews were posted within minutes of each other and follow a similar structure. Each account uses a different device and has verified bookings.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which conclusion is most appropriate?",
    "options": [
      {
        "letter": "A",
        "text": "Verified bookings guarantee that no misuse occurred.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The reviews should immediately be removed.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The activity shows risk indicators but requires evidence-based evaluation.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The accounts should be permanently suspended.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 27,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 7",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q28",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-07",
    "case_title": "Coordinated Activity Across Multiple Accounts",
    "tabs": [
    {
        "name": "Case File",
        "content": "Four different accounts posted reviews for the same group of properties over several weeks. The reviews were posted within minutes of each other and follow a similar structure. Each account uses a different device and has verified bookings.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which assumption should be avoided?",
    "options": [
      {
        "letter": "A",
        "text": "Patterns across accounts can be meaningful.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Multiple indicators should be considered together.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Different devices mean the accounts cannot be connected.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Verified activity does not remove all risk.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 28,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 7",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q29",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-08",
    "case_title": "Unusual Activity From a Trusted User",
    "tabs": [
    {
        "name": "Case File",
        "content": "A user with a seven-year account history posts eight reviews in one day while travelling across different cities. All reviews are linked to verified bookings. The reviews contain different writing styles and detailed stay experiences.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the most balanced assessment of this activity?",
    "options": [
      {
        "letter": "A",
        "text": "The account is fraudulent because of high activity.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The reviews should be ignored because the account is old.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The activity is unusual but has legitimate indicators as well.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The account should be restricted immediately.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 29,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 8",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q30",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-08",
    "case_title": "Unusual Activity From a Trusted User",
    "tabs": [
    {
        "name": "Case File",
        "content": "A user with a seven-year account history posts eight reviews in one day while travelling across different cities. All reviews are linked to verified bookings. The reviews contain different writing styles and detailed stay experiences.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which factors reduce the likelihood of suspicious activity?",
    "options": [
      {
        "letter": "A",
        "text": "Verified bookings",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Long account history",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Detailed and varied review content",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Multiple reviews posted in one day",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 30,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 8",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q31",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-08",
    "case_title": "Unusual Activity From a Trusted User",
    "tabs": [
    {
        "name": "Case File",
        "content": "A user with a seven-year account history posts eight reviews in one day while travelling across different cities. All reviews are linked to verified bookings. The reviews contain different writing styles and detailed stay experiences.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement best reflects critical thinking in this case?",
    "options": [
      {
        "letter": "A",
        "text": "Unusual behavior always means fraud.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Trusted users cannot misuse the platform.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Unusual activity should be evaluated using the complete context.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The number of reviews alone determines the risk.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 31,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 8",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q32",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-08",
    "case_title": "Unusual Activity From a Trusted User",
    "tabs": [
    {
        "name": "Case File",
        "content": "A user with a seven-year account history posts eight reviews in one day while travelling across different cities. All reviews are linked to verified bookings. The reviews contain different writing styles and detailed stay experiences.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which factor should have the least influence on the final decision?",
    "options": [
      {
        "letter": "A",
        "text": "Booking verification",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Account history",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Review details",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The fact that the user posted many reviews in one day alone",
        "is_correct": true
      }
    ],
    "model_answer": null,
    "position": 32,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 8",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q33",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-09",
    "case_title": "Listing Information Dispute",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler reports that a property advertised free breakfast when they booked their stay. The property owner states that the listing was updated before the traveler's arrival. Records show that the listing was changed after the booking was completed but before check-in.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the key issue in this case?",
    "options": [
      {
        "letter": "A",
        "text": "Whether the property has good reviews.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Whether the traveler saw different information at the time of booking.",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Whether the owner responded to the complaint.",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Whether the traveler liked the property.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 33,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 9",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q34",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-09",
    "case_title": "Listing Information Dispute",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler reports that a property advertised free breakfast when they booked their stay. The property owner states that the listing was updated before the traveler's arrival. Records show that the listing was changed after the booking was completed but before check-in.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which factors are important when assessing this dispute?",
    "options": [
      {
        "letter": "A",
        "text": "Information displayed when the booking was made",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Timeline of listing changes",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Property popularity",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Difference between advertised and actual information",
        "is_correct": true
      }
    ],
    "model_answer": null,
    "position": 34,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 9",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q35",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-09",
    "case_title": "Listing Information Dispute",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler reports that a property advertised free breakfast when they booked their stay. The property owner states that the listing was updated before the traveler's arrival. Records show that the listing was changed after the booking was completed but before check-in.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which conclusion is NOT justified based only on the available information?",
    "options": [
      {
        "letter": "A",
        "text": "The timeline needs to be considered.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Listing history can impact the decision.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The current listing always represents what the traveler originally saw.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Historical information may be relevant.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 35,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 9",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q36",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-09",
    "case_title": "Listing Information Dispute",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler reports that a property advertised free breakfast when they booked their stay. The property owner states that the listing was updated before the traveler's arrival. Records show that the listing was changed after the booking was completed but before check-in.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which decision best demonstrates fair judgment?",
    "options": [
      {
        "letter": "A",
        "text": "Always support the traveler.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Always support the property owner.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Evaluate the information available at the time of booking before deciding.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Ignore the complaint because listings can change.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 36,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 9",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q37",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-10",
    "case_title": "Complex Risk Assessment",
    "tabs": [
    {
        "name": "Case File",
        "content": "A new account submits a detailed review linked to a verified booking. The review has similarities with another review, both accounts are connected through the same device, and one account has a previous suspicious activity report. However, both reviews contain unique details about the stay.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Why is this case challenging?",
    "options": [
      {
        "letter": "A",
        "text": "The account is new.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The review is detailed.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The case contains both risk indicators and legitimate signals.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property has received multiple reviews.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 37,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 10",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q38",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-10",
    "case_title": "Complex Risk Assessment",
    "tabs": [
    {
        "name": "Case File",
        "content": "A new account submits a detailed review linked to a verified booking. The review has similarities with another review, both accounts are connected through the same device, and one account has a previous suspicious activity report. However, both reviews contain unique details about the stay.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which details increase the risk level?",
    "options": [
      {
        "letter": "A",
        "text": "Shared device connection",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similar review content",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Previous suspicious activity report",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Verified booking",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 38,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 10",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q39",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-10",
    "case_title": "Complex Risk Assessment",
    "tabs": [
    {
        "name": "Case File",
        "content": "A new account submits a detailed review linked to a verified booking. The review has similarities with another review, both accounts are connected through the same device, and one account has a previous suspicious activity report. However, both reviews contain unique details about the stay.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement best represents the available evidence?",
    "options": [
      {
        "letter": "A",
        "text": "The review is definitely fake.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The review is definitely genuine.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The evidence suggests concern but does not confirm a violation.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The verified booking removes all risk.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 39,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 10",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q40",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-10",
    "case_title": "Complex Risk Assessment",
    "tabs": [
    {
        "name": "Case File",
        "content": "A new account submits a detailed review linked to a verified booking. The review has similarities with another review, both accounts are connected through the same device, and one account has a previous suspicious activity report. However, both reviews contain unique details about the stay.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which decision best balances risk management and fairness?",
    "options": [
      {
        "letter": "A",
        "text": "Remove the review immediately.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Approve the review without review.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Consider all evidence before deciding on any action.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Ignore suspicious indicators because the review is detailed.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 40,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 10",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q41",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-11",
    "case_title": "Multiple Reports Against One Reviewer",
    "tabs": [
    {
        "name": "Case File",
        "content": "A reviewer has submitted 15 reviews in the past six months. Three different property owners have reported separate reviews, claiming they contain false information. All reviews are linked to verified bookings, and no previous policy violations have been confirmed.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the most balanced assessment of this case?",
    "options": [
      {
        "letter": "A",
        "text": "The reviewer is fraudulent because multiple reports exist.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The reviewer is trustworthy because all bookings are verified.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The reports require evaluation while considering both account history and available evidence.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The reports should be ignored because there are no confirmed violations.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 41,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 11",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q42",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-11",
    "case_title": "Multiple Reports Against One Reviewer",
    "tabs": [
    {
        "name": "Case File",
        "content": "A reviewer has submitted 15 reviews in the past six months. Three different property owners have reported separate reviews, claiming they contain false information. All reviews are linked to verified bookings, and no previous policy violations have been confirmed.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which factors are relevant when assessing the concern?",
    "options": [
      {
        "letter": "A",
        "text": "The content of each reported review",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The consistency of concerns across multiple reports",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The reviewer's verified booking history",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property's overall rating",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 42,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 11",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q43",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-11",
    "case_title": "Multiple Reports Against One Reviewer",
    "tabs": [
    {
        "name": "Case File",
        "content": "A reviewer has submitted 15 reviews in the past six months. Three different property owners have reported separate reviews, claiming they contain false information. All reviews are linked to verified bookings, and no previous policy violations have been confirmed.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which conclusion is NOT supported by the available information?",
    "options": [
      {
        "letter": "A",
        "text": "Multiple reports may indicate a pattern worth reviewing.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Verified bookings provide useful context.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Multiple reports automatically confirm fraudulent activity.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Each reported review should be assessed based on evidence.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 43,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 11",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q44",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-11",
    "case_title": "Multiple Reports Against One Reviewer",
    "tabs": [
    {
        "name": "Case File",
        "content": "A reviewer has submitted 15 reviews in the past six months. Three different property owners have reported separate reviews, claiming they contain false information. All reviews are linked to verified bookings, and no previous policy violations have been confirmed.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which approach demonstrates sound judgment?",
    "options": [
      {
        "letter": "A",
        "text": "Remove all reported reviews immediately.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Ignore the reports because the reviewer has verified bookings.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Consider both positive and negative indicators before reaching a decision.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Take action only based on the number of reports received.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 44,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 11",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q45",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-12",
    "case_title": "Shared Payment Method Across Accounts",
    "tabs": [
    {
        "name": "Case File",
        "content": "Three different accounts used the same payment method for bookings. The accounts belong to different names, travelled to different destinations, and have completed stays. No suspicious activity has previously been identified on any account.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the most reasonable interpretation of this situation?",
    "options": [
      {
        "letter": "A",
        "text": "The accounts are definitely connected for fraudulent activity.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The accounts are definitely unrelated.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The shared payment method is a potential indicator but does not confirm misuse by itself.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "All accounts should be restricted immediately.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 45,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 12",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q46",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-12",
    "case_title": "Shared Payment Method Across Accounts",
    "tabs": [
    {
        "name": "Case File",
        "content": "Three different accounts used the same payment method for bookings. The accounts belong to different names, travelled to different destinations, and have completed stays. No suspicious activity has previously been identified on any account.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which details reduce the level of concern?",
    "options": [
      {
        "letter": "A",
        "text": "Different travel destinations",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Completed stays",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "No previous suspicious activity",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The accounts share a payment method",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 46,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 12",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q47",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-12",
    "case_title": "Shared Payment Method Across Accounts",
    "tabs": [
    {
        "name": "Case File",
        "content": "Three different accounts used the same payment method for bookings. The accounts belong to different names, travelled to different destinations, and have completed stays. No suspicious activity has previously been identified on any account.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement best reflects critical thinking?",
    "options": [
      {
        "letter": "A",
        "text": "Any shared information between accounts confirms fraud.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Legitimate users cannot share payment methods.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "A single indicator should be evaluated along with the complete context.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Payment information should always be ignored.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 47,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 12",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q48",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-12",
    "case_title": "Shared Payment Method Across Accounts",
    "tabs": [
    {
        "name": "Case File",
        "content": "Three different accounts used the same payment method for bookings. The accounts belong to different names, travelled to different destinations, and have completed stays. No suspicious activity has previously been identified on any account.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which factor would increase the risk level in this case?",
    "options": [
      {
        "letter": "A",
        "text": "Different travel dates",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Completed bookings",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Additional evidence showing coordinated misuse between the accounts",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Different destinations",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 48,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 12",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q49",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-13",
    "case_title": "Conflicting Claims About a Stay",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler claims they never stayed at a property and says the booking was unauthorized. Booking records show a completed stay, and the property owner has provided check-in records matching the booking details. The traveler continues to dispute the information.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What makes this case challenging?",
    "options": [
      {
        "letter": "A",
        "text": "The property has provided information.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The booking was completed.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The available information contains conflicting claims from both sides.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The traveler contacted support.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 49,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 13",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q50",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-13",
    "case_title": "Conflicting Claims About a Stay",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler claims they never stayed at a property and says the booking was unauthorized. Booking records show a completed stay, and the property owner has provided check-in records matching the booking details. The traveler continues to dispute the information.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which factors should influence the evaluation of this case?",
    "options": [
      {
        "letter": "A",
        "text": "Booking records",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Information provided by both parties",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Account activity related to the booking",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Property popularity",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 50,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 13",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q51",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-13",
    "case_title": "Conflicting Claims About a Stay",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler claims they never stayed at a property and says the booking was unauthorized. Booking records show a completed stay, and the property owner has provided check-in records matching the booking details. The traveler continues to dispute the information.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which conclusion is most appropriate based on the information provided?",
    "options": [
      {
        "letter": "A",
        "text": "The traveler is definitely incorrect.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The property owner is definitely incorrect.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Additional context is needed because the claims conflict.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The case should be closed immediately.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 51,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 13",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q52",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-13",
    "case_title": "Conflicting Claims About a Stay",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler claims they never stayed at a property and says the booking was unauthorized. Booking records show a completed stay, and the property owner has provided check-in records matching the booking details. The traveler continues to dispute the information.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which assumption should be avoided?",
    "options": [
      {
        "letter": "A",
        "text": "Multiple sources of evidence should be considered.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Conflicting claims require careful evaluation.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "One source of information automatically proves the complete truth.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Decisions should be based on available evidence.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 52,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 13",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q53",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-14",
    "case_title": "Sudden Increase in Positive Reviews",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property usually receives two to three reviews per month. Over one weekend, it receives 25 five-star reviews from accounts created within the same week. Many reviews are short and contain similar wording.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the strongest risk indicator in this case?",
    "options": [
      {
        "letter": "A",
        "text": "The reviews are positive.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The reviews are short.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "A sudden unusual pattern involving many new accounts.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property received more attention.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 53,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 14",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q54",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-14",
    "case_title": "Sudden Increase in Positive Reviews",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property usually receives two to three reviews per month. Over one weekend, it receives 25 five-star reviews from accounts created within the same week. Many reviews are short and contain similar wording.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which details contribute to the risk assessment?",
    "options": [
      {
        "letter": "A",
        "text": "Multiple newly created accounts",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Sudden increase in review volume",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Similar wording across reviews",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Five-star ratings alone",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 54,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 14",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q55",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-14",
    "case_title": "Sudden Increase in Positive Reviews",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property usually receives two to three reviews per month. Over one weekend, it receives 25 five-star reviews from accounts created within the same week. Many reviews are short and contain similar wording.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is most accurate?",
    "options": [
      {
        "letter": "A",
        "text": "Positive reviews cannot create risk.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "All new accounts are fraudulent.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "A combination of unusual patterns may indicate possible coordinated activity.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "A high number of reviews always benefits the property.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 55,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 14",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q56",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-14",
    "case_title": "Sudden Increase in Positive Reviews",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property usually receives two to three reviews per month. Over one weekend, it receives 25 five-star reviews from accounts created within the same week. Many reviews are short and contain similar wording.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which decision best balances fairness and risk management?",
    "options": [
      {
        "letter": "A",
        "text": "Remove all reviews because they look suspicious.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Ignore the reviews because they are positive.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Evaluate the available evidence before deciding on action.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Accept the reviews without assessment.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 56,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 14",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q57",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-15",
    "case_title": "Repeated Verification Inconsistencies",
    "tabs": [
    {
        "name": "Case File",
        "content": "A user has attempted identity verification four times in one week. Each submission contains a different document. Some documents appear valid, but personal information differs across submissions.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the primary concern in this case?",
    "options": [
      {
        "letter": "A",
        "text": "The user attempted verification multiple times.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Inconsistent information across submitted documents.",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The verification process took one week.",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The user submitted more than one document.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 57,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 15",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q58",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-15",
    "case_title": "Repeated Verification Inconsistencies",
    "tabs": [
    {
        "name": "Case File",
        "content": "A user has attempted identity verification four times in one week. Each submission contains a different document. Some documents appear valid, but personal information differs across submissions.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which factors increase the level of concern?",
    "options": [
      {
        "letter": "A",
        "text": "Differences in personal information",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Multiple conflicting submissions",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Unclear consistency across documents",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The user attempted verification more than once",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 58,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 15",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q59",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-15",
    "case_title": "Repeated Verification Inconsistencies",
    "tabs": [
    {
        "name": "Case File",
        "content": "A user has attempted identity verification four times in one week. Each submission contains a different document. Some documents appear valid, but personal information differs across submissions.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which conclusion is most reasonable?",
    "options": [
      {
        "letter": "A",
        "text": "The user is definitely committing fraud.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The user should automatically be approved.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The inconsistencies require careful evaluation before reaching a decision.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Previous submissions should be ignored.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 59,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 15",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q60",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-15",
    "case_title": "Repeated Verification Inconsistencies",
    "tabs": [
    {
        "name": "Case File",
        "content": "A user has attempted identity verification four times in one week. Each submission contains a different document. Some documents appear valid, but personal information differs across submissions.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which principle should guide the final decision?",
    "options": [
      {
        "letter": "A",
        "text": "The newest document should always be accepted.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Multiple attempts always indicate fraud.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Decisions should be based on the complete set of available evidence.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "A single matching detail is enough to confirm identity.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 60,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 15",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q61",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-16",
    "case_title": "Sudden Change in Jordan Leeehavior",
    "tabs": [
    {
        "name": "Case File",
        "content": "A user with a five-year account history and consistent activity suddenly creates 20 reviews within two days. The reviews are for different properties across multiple locations. All reviews are linked to completed bookings, but the writing style is noticeably different from the user's previous reviews.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the most appropriate assessment of this case?",
    "options": [
      {
        "letter": "A",
        "text": "The account is fraudulent because the activity changed.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The reviews are genuine because all bookings are completed.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The activity is unusual and requires evaluation using multiple factors.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The account should be restricted immediately.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 61,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 16",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q62",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-16",
    "case_title": "Sudden Change in Jordan Leeehavior",
    "tabs": [
    {
        "name": "Case File",
        "content": "A user with a five-year account history and consistent activity suddenly creates 20 reviews within two days. The reviews are for different properties across multiple locations. All reviews are linked to completed bookings, but the writing style is noticeably different from the user's previous reviews.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which factors reduce the risk level?",
    "options": [
      {
        "letter": "A",
        "text": "Completed bookings",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Long account history",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Reviews are linked to different locations",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Sudden increase in activity",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 62,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 16",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q63",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-16",
    "case_title": "Sudden Change in Jordan Leeehavior",
    "tabs": [
    {
        "name": "Case File",
        "content": "A user with a five-year account history and consistent activity suddenly creates 20 reviews within two days. The reviews are for different properties across multiple locations. All reviews are linked to completed bookings, but the writing style is noticeably different from the user's previous reviews.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which factor creates the most uncertainty in this case?",
    "options": [
      {
        "letter": "A",
        "text": "The number of properties reviewed.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The account age.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "A significant change in behavior compared to previous activity.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The user has completed bookings.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 63,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 16",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q64",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-16",
    "case_title": "Sudden Change in Jordan Leeehavior",
    "tabs": [
    {
        "name": "Case File",
        "content": "A user with a five-year account history and consistent activity suddenly creates 20 reviews within two days. The reviews are for different properties across multiple locations. All reviews are linked to completed bookings, but the writing style is noticeably different from the user's previous reviews.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement best reflects sound judgment?",
    "options": [
      {
        "letter": "A",
        "text": "Any unusual activity confirms account misuse.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Long-term accounts cannot be risky.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Changes in behavior should be assessed along with supporting evidence.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Completed bookings remove all concerns.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 64,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 16",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q65",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-17",
    "case_title": "Review Content Matches External Information",
    "tabs": [
    {
        "name": "Case File",
        "content": "A reviewer posts a detailed review describing specific issues during a stay. The property owner claims the review is fake because the reviewer mentioned information that appears similar to details from another online source. The booking is verified, and the reviewer has no previous violations.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the key consideration in this case?",
    "options": [
      {
        "letter": "A",
        "text": "The review is detailed.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The property owner disagrees with the review.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Whether the review reflects a genuine experience despite similarities with other information.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Whether the reviewer has posted before.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 65,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 17",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q66",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-17",
    "case_title": "Review Content Matches External Information",
    "tabs": [
    {
        "name": "Case File",
        "content": "A reviewer posts a detailed review describing specific issues during a stay. The property owner claims the review is fake because the reviewer mentioned information that appears similar to details from another online source. The booking is verified, and the reviewer has no previous violations.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which factors support the possibility that the review is genuine?",
    "options": [
      {
        "letter": "A",
        "text": "Verified booking",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Specific details about the stay",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "No previous violations",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Similar wording to external information",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 66,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 17",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q67",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-17",
    "case_title": "Review Content Matches External Information",
    "tabs": [
    {
        "name": "Case File",
        "content": "A reviewer posts a detailed review describing specific issues during a stay. The property owner claims the review is fake because the reviewer mentioned information that appears similar to details from another online source. The booking is verified, and the reviewer has no previous violations.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which conclusion is most appropriate?",
    "options": [
      {
        "letter": "A",
        "text": "Similar wording automatically means the review is fake.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The review should remain without any evaluation.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Similarities should be considered along with other evidence.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property owner's concern confirms manipulation.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 67,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 17",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q68",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-17",
    "case_title": "Review Content Matches External Information",
    "tabs": [
    {
        "name": "Case File",
        "content": "A reviewer posts a detailed review describing specific issues during a stay. The property owner claims the review is fake because the reviewer mentioned information that appears similar to details from another online source. The booking is verified, and the reviewer has no previous violations.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which assumption should be avoided?",
    "options": [
      {
        "letter": "A",
        "text": "Evidence should be evaluated as a whole.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Similar information may have multiple explanations.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Any similarity proves dishonest behavior.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Verified activity is an important factor.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 68,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 17",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q69",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-18",
    "case_title": "Multiple Accounts With Similar Profiles",
    "tabs": [
    {
        "name": "Case File",
        "content": "Five accounts created within the same month have similar usernames, similar profile descriptions, and have only reviewed properties from the same city. Four accounts have completed bookings, while one account has no booking history.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the strongest risk indicator?",
    "options": [
      {
        "letter": "A",
        "text": "The accounts were created in the same month.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The accounts reviewed properties from the same city.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Multiple accounts showing similar characteristics and activity patterns.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Four accounts have completed bookings.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 69,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 18",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q70",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-18",
    "case_title": "Multiple Accounts With Similar Profiles",
    "tabs": [
    {
        "name": "Case File",
        "content": "Five accounts created within the same month have similar usernames, similar profile descriptions, and have only reviewed properties from the same city. Four accounts have completed bookings, while one account has no booking history.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which details increase the concern level?",
    "options": [
      {
        "letter": "A",
        "text": "Similar usernames",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similar profile information",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Concentrated activity around the same properties/location",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Completed bookings",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 70,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 18",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q71",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-18",
    "case_title": "Multiple Accounts With Similar Profiles",
    "tabs": [
    {
        "name": "Case File",
        "content": "Five accounts created within the same month have similar usernames, similar profile descriptions, and have only reviewed properties from the same city. Four accounts have completed bookings, while one account has no booking history.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is most accurate?",
    "options": [
      {
        "letter": "A",
        "text": "The accounts are definitely operated by the same person.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The accounts are definitely genuine because some bookings exist.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The pattern suggests possible connections, but evidence should determine the conclusion.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The accounts should automatically be removed.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 71,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 18",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q72",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-18",
    "case_title": "Multiple Accounts With Similar Profiles",
    "tabs": [
    {
        "name": "Case File",
        "content": "Five accounts created within the same month have similar usernames, similar profile descriptions, and have only reviewed properties from the same city. Four accounts have completed bookings, while one account has no booking history.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the biggest risk if such patterns are ignored?",
    "options": [
      {
        "letter": "A",
        "text": "More users may create profiles.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Coordinated misuse may continue undetected.",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Properties may receive more reviews.",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "Account activity may increase.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 72,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 18",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q73",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-19",
    "case_title": "Customer Complaint With Limited Details",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler reports that a property listing was misleading but provides only a short message stating, \"The information was incorrect.\" No screenshots, booking details, or specific examples are provided. The property listing currently appears accurate.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the biggest challenge in this case?",
    "options": [
      {
        "letter": "A",
        "text": "The property listing exists.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The traveler submitted a complaint.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "There is limited information available to evaluate the claim.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property has not responded.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 73,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 19",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q74",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-19",
    "case_title": "Customer Complaint With Limited Details",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler reports that a property listing was misleading but provides only a short message stating, \"The information was incorrect.\" No screenshots, booking details, or specific examples are provided. The property listing currently appears accurate.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which factors make it difficult to reach a conclusion?",
    "options": [
      {
        "letter": "A",
        "text": "No specific details about the issue",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "No supporting evidence provided",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Missing booking context",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property listing is available",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 74,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 19",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q75",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-19",
    "case_title": "Customer Complaint With Limited Details",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler reports that a property listing was misleading but provides only a short message stating, \"The information was incorrect.\" No screenshots, booking details, or specific examples are provided. The property listing currently appears accurate.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which conclusion is best supported by the evidence?",
    "options": [
      {
        "letter": "A",
        "text": "The listing is misleading.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The complaint is invalid.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The available information is insufficient to confirm either conclusion.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property should be removed.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 75,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 19",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q76",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-19",
    "case_title": "Customer Complaint With Limited Details",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler reports that a property listing was misleading but provides only a short message stating, \"The information was incorrect.\" No screenshots, booking details, or specific examples are provided. The property listing currently appears accurate.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which decision demonstrates fair judgment?",
    "options": [
      {
        "letter": "A",
        "text": "Always support customer complaints.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Always trust the current listing.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Avoid making a decision without sufficient evidence.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Ignore complaints without attachments.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 76,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 19",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q77",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-20",
    "case_title": "Conflicting Signals in a Fraud Report",
    "tabs": [
    {
        "name": "Case File",
        "content": "A review has several risk indicators:\nThe account was recently created.\nThe review wording is similar to another review.\nThe reviewer has a verified booking.\nThe review includes detailed information about the stay.\nThe property owner disputes the review.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Why is this case difficult to assess?",
    "options": [
      {
        "letter": "A",
        "text": "The review contains negative feedback.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The property owner reported it.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The case contains both suspicious and legitimate indicators.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The reviewer has a verified booking.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 77,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 20",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q78",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-20",
    "case_title": "Conflicting Signals in a Fraud Report",
    "tabs": [
    {
        "name": "Case File",
        "content": "A review has several risk indicators:\nThe account was recently created.\nThe review wording is similar to another review.\nThe reviewer has a verified booking.\nThe review includes detailed information about the stay.\nThe property owner disputes the review.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which details increase suspicion?",
    "options": [
      {
        "letter": "A",
        "text": "Recently created account",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similar review wording",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Property owner dispute",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Detailed stay information",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 78,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 20",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q79",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-20",
    "case_title": "Conflicting Signals in a Fraud Report",
    "tabs": [
    {
        "name": "Case File",
        "content": "A review has several risk indicators:\nThe account was recently created.\nThe review wording is similar to another review.\nThe reviewer has a verified booking.\nThe review includes detailed information about the stay.\nThe property owner disputes the review.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which detail provides a factor supporting legitimacy?",
    "options": [
      {
        "letter": "A",
        "text": "Similar wording",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "New account",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Verified booking and specific stay details",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Property complaint",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 79,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 20",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q80",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-20",
    "case_title": "Conflicting Signals in a Fraud Report",
    "tabs": [
    {
        "name": "Case File",
        "content": "A review has several risk indicators:\nThe account was recently created.\nThe review wording is similar to another review.\nThe reviewer has a verified booking.\nThe review includes detailed information about the stay.\nThe property owner disputes the review.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which decision best reflects critical thinking?",
    "options": [
      {
        "letter": "A",
        "text": "Remove the review because suspicious indicators exist.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Approve the review because a booking exists.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Balance all evidence before deciding whether action is needed.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Ignore the suspicious indicators because the review is detailed.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 80,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 20",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q81",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-21",
    "case_title": "Sudden Increase in Complaints",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property has maintained a high rating for several years. Over the last month, the property received 12 complaints from different travelers stating that the actual experience did not match the listing description. The property owner claims that all complaints are from unhappy customers who misunderstood the information.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the most important factor when assessing this situation?",
    "options": [
      {
        "letter": "A",
        "text": "The property’s previous high rating.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The property owner’s explanation.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "A repeated pattern of similar complaints from different travelers.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The number of years the property has been active.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 81,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 21",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q82",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-21",
    "case_title": "Sudden Increase in Complaints",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property has maintained a high rating for several years. Over the last month, the property received 12 complaints from different travelers stating that the actual experience did not match the listing description. The property owner claims that all complaints are from unhappy customers who misunderstood the information.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which details increase the concern level?",
    "options": [
      {
        "letter": "A",
        "text": "Multiple travelers reporting a similar issue",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Complaints occurring within a short period",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "A consistent mismatch between expectations and actual experience",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property has many positive reviews",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 82,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 21",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q83",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-21",
    "case_title": "Sudden Increase in Complaints",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property has maintained a high rating for several years. Over the last month, the property received 12 complaints from different travelers stating that the actual experience did not match the listing description. The property owner claims that all complaints are from unhappy customers who misunderstood the information.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which conclusion is best supported by the available evidence?",
    "options": [
      {
        "letter": "A",
        "text": "The property is definitely misleading customers.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The complaints should be ignored because the property has a good history.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The repeated pattern suggests the concern requires further evaluation.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Individual complaints never indicate a larger issue.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 83,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 21",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q84",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-21",
    "case_title": "Sudden Increase in Complaints",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property has maintained a high rating for several years. Over the last month, the property received 12 complaints from different travelers stating that the actual experience did not match the listing description. The property owner claims that all complaints are from unhappy customers who misunderstood the information.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which assumption should be avoided?",
    "options": [
      {
        "letter": "A",
        "text": "Previous history can provide useful context.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Repeated complaints may indicate a pattern.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "A highly rated property cannot have listing issues.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Customer complaints should be evaluated using evidence.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 84,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 21",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q85",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-22",
    "case_title": "Review Removed but New Complaint Submitted",
    "tabs": [
    {
        "name": "Case File",
        "content": "A review was previously removed after a policy violation was confirmed. The same reviewer creates a new account and posts another review for the same property. The new review is linked to a verified booking, but the wording is similar to the previously removed review.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the biggest risk indicator in this case?",
    "options": [
      {
        "letter": "A",
        "text": "The new review has a verified booking.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The reviewer created a new account.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Similar behavior appears after a previous confirmed violation.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property received another review.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 85,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 22",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q86",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-22",
    "case_title": "Review Removed but New Complaint Submitted",
    "tabs": [
    {
        "name": "Case File",
        "content": "A review was previously removed after a policy violation was confirmed. The same reviewer creates a new account and posts another review for the same property. The new review is linked to a verified booking, but the wording is similar to the previously removed review.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which factors should influence the risk assessment?",
    "options": [
      {
        "letter": "A",
        "text": "Previous confirmed violation",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similarity between the old and new review",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Connection between the accounts",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Review rating",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 86,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 22",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q87",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-22",
    "case_title": "Review Removed but New Complaint Submitted",
    "tabs": [
    {
        "name": "Case File",
        "content": "A review was previously removed after a policy violation was confirmed. The same reviewer creates a new account and posts another review for the same property. The new review is linked to a verified booking, but the wording is similar to the previously removed review.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is most accurate?",
    "options": [
      {
        "letter": "A",
        "text": "A verified booking eliminates concerns.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "A new account means the user is definitely different.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Previous behavior can provide important context when assessing current activity.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The new review should automatically be removed.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 87,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 22",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q88",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-22",
    "case_title": "Review Removed but New Complaint Submitted",
    "tabs": [
    {
        "name": "Case File",
        "content": "A review was previously removed after a policy violation was confirmed. The same reviewer creates a new account and posts another review for the same property. The new review is linked to a verified booking, but the wording is similar to the previously removed review.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which decision best balances fairness and risk management?",
    "options": [
      {
        "letter": "A",
        "text": "Ignore the previous violation.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Remove the review only because the user has history.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Consider both the current review evidence and previous account behavior.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Approve the review without evaluation.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 88,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 22",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q89",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-23",
    "case_title": "Legitimate Negative Review With Property Dispute",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler posts a one-star review describing poor cleanliness and delayed service. The property owner reports the review, stating that it is unfair and damaging to their reputation. The booking is verified, and the review contains specific details about the stay.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the main consideration in this case?",
    "options": [
      {
        "letter": "A",
        "text": "The review has a low rating.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The property owner disagrees with the review.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Whether the review reflects a genuine experience and follows guidelines.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Whether the review affects the property's rating.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 89,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 23",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q90",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-23",
    "case_title": "Legitimate Negative Review With Property Dispute",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler posts a one-star review describing poor cleanliness and delayed service. The property owner reports the review, stating that it is unfair and damaging to their reputation. The booking is verified, and the review contains specific details about the stay.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which details support the possibility that the review is genuine?",
    "options": [
      {
        "letter": "A",
        "text": "Verified booking",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Specific details about the stay",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The review describes a personal experience",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property owner disputes it",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 90,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 23",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q91",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-23",
    "case_title": "Legitimate Negative Review With Property Dispute",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler posts a one-star review describing poor cleanliness and delayed service. The property owner reports the review, stating that it is unfair and damaging to their reputation. The booking is verified, and the review contains specific details about the stay.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which conclusion is NOT justified?",
    "options": [
      {
        "letter": "A",
        "text": "Negative feedback alone does not prove a violation.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Verified experiences can include criticism.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "A negative review should be removed because it affects the property.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The review should be evaluated against available evidence.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 91,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 23",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q92",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-23",
    "case_title": "Legitimate Negative Review With Property Dispute",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler posts a one-star review describing poor cleanliness and delayed service. The property owner reports the review, stating that it is unfair and damaging to their reputation. The booking is verified, and the review contains specific details about the stay.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which decision demonstrates balanced judgment?",
    "options": [
      {
        "letter": "A",
        "text": "Remove the review to protect the property.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Keep the review only because the traveler is unhappy.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Evaluate whether the content is genuine and compliant before deciding.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Prioritize the property owner's preference.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 92,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 23",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q93",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-24",
    "case_title": "Coordinated Positive Reviews With Mixed Evidence",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property receives 15 positive reviews within three days. Most reviews come from newly created accounts, and many use similar phrases. However, five reviewers have verified bookings and provide detailed descriptions of their stays.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Why is this case challenging?",
    "options": [
      {
        "letter": "A",
        "text": "Positive reviews are always difficult to assess.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Verified bookings prove all reviews are genuine.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The case contains both suspicious patterns and legitimate indicators.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property received too many reviews.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 93,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 24",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q94",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-24",
    "case_title": "Coordinated Positive Reviews With Mixed Evidence",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property receives 15 positive reviews within three days. Most reviews come from newly created accounts, and many use similar phrases. However, five reviewers have verified bookings and provide detailed descriptions of their stays.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which details increase suspicion?",
    "options": [
      {
        "letter": "A",
        "text": "Multiple newly created accounts",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similar wording across reviews",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Unusual increase in review volume",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Detailed stay descriptions",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 94,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 24",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q95",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-24",
    "case_title": "Coordinated Positive Reviews With Mixed Evidence",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property receives 15 positive reviews within three days. Most reviews come from newly created accounts, and many use similar phrases. However, five reviewers have verified bookings and provide detailed descriptions of their stays.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement best reflects critical thinking?",
    "options": [
      {
        "letter": "A",
        "text": "All reviews should be removed because some appear suspicious.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "All reviews should be approved because some have verified bookings.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Each review should be evaluated while considering the overall pattern.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Positive reviews do not require assessment.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 95,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 24",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q96",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-24",
    "case_title": "Coordinated Positive Reviews With Mixed Evidence",
    "tabs": [
    {
        "name": "Case File",
        "content": "A property receives 15 positive reviews within three days. Most reviews come from newly created accounts, and many use similar phrases. However, five reviewers have verified bookings and provide detailed descriptions of their stays.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which factor reduces concern for some reviews?",
    "options": [
      {
        "letter": "A",
        "text": "Five-star ratings",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Recent posting date",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Verified bookings with specific stay details",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Similar wording",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 96,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 24",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q97",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-25",
    "case_title": "Account Recovery and Suspicious Activity",
    "tabs": [
    {
        "name": "Case File",
        "content": "A user reports that their account was compromised and that several reviews were posted without their permission. Account activity shows a login from a new location before the reviews were submitted. However, the reviews are linked to completed bookings associated with the account.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What makes this case complex?",
    "options": [
      {
        "letter": "A",
        "text": "The user reported account access issues.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The reviews are positive.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "There are indicators supporting both legitimate activity and possible account misuse.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The account has completed bookings.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 97,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 25",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q98",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-25",
    "case_title": "Account Recovery and Suspicious Activity",
    "tabs": [
    {
        "name": "Case File",
        "content": "A user reports that their account was compromised and that several reviews were posted without their permission. Account activity shows a login from a new location before the reviews were submitted. However, the reviews are linked to completed bookings associated with the account.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which details are relevant when assessing this situation?",
    "options": [
      {
        "letter": "A",
        "text": "Unusual login activity",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Timing of account access and review submission",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Connection between bookings and reviews",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Number of profile photos",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 98,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 25",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q99",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-25",
    "case_title": "Account Recovery and Suspicious Activity",
    "tabs": [
    {
        "name": "Case File",
        "content": "A user reports that their account was compromised and that several reviews were posted without their permission. Account activity shows a login from a new location before the reviews were submitted. However, the reviews are linked to completed bookings associated with the account.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which conclusion is most reasonable?",
    "options": [
      {
        "letter": "A",
        "text": "The user’s claim is false because bookings exist.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The reviews are definitely unauthorized.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The available evidence should be considered together before reaching a conclusion.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The account should automatically be closed.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 99,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 25",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q100",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-25",
    "case_title": "Account Recovery and Suspicious Activity",
    "tabs": [
    {
        "name": "Case File",
        "content": "A user reports that their account was compromised and that several reviews were posted without their permission. Account activity shows a login from a new location before the reviews were submitted. However, the reviews are linked to completed bookings associated with the account.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which principle should guide the final decision?",
    "options": [
      {
        "letter": "A",
        "text": "Trust the account owner in all cases.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Trust system records without considering other evidence.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Balance account security signals with available activity evidence.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Focus only on the newest information.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 100,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 25",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q101",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-26",
    "case_title": "Multiple Accounts With Similar Behavior",
    "tabs": [
    {
        "name": "Case File",
        "content": "A group of six accounts has posted reviews for the same property over a two-week period. The accounts were created at different times, but they have similar profile details, similar writing styles, and frequently interact with each other’s reviews. Some accounts have verified bookings, while others do not.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the biggest risk indicator in this case?",
    "options": [
      {
        "letter": "A",
        "text": "The accounts were created at different times.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Some accounts have verified bookings.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Multiple accounts show similar behavior and connections.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property received several reviews.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 101,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 26",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q102",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-26",
    "case_title": "Multiple Accounts With Similar Behavior",
    "tabs": [
    {
        "name": "Case File",
        "content": "A group of six accounts has posted reviews for the same property over a two-week period. The accounts were created at different times, but they have similar profile details, similar writing styles, and frequently interact with each other’s reviews. Some accounts have verified bookings, while others do not.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which details increase the concern level?",
    "options": [
      {
        "letter": "A",
        "text": "Similar profile information",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similar writing patterns",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Interaction patterns between accounts",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Different account creation dates",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 102,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 26",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q103",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-26",
    "case_title": "Multiple Accounts With Similar Behavior",
    "tabs": [
    {
        "name": "Case File",
        "content": "A group of six accounts has posted reviews for the same property over a two-week period. The accounts were created at different times, but they have similar profile details, similar writing styles, and frequently interact with each other’s reviews. Some accounts have verified bookings, while others do not.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which conclusion is most appropriate?",
    "options": [
      {
        "letter": "A",
        "text": "All accounts are fraudulent.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "All accounts are genuine because some have verified bookings.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The pattern suggests possible coordination, but evidence should determine the outcome.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The accounts should be removed immediately.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 103,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 26",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q104",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-26",
    "case_title": "Multiple Accounts With Similar Behavior",
    "tabs": [
    {
        "name": "Case File",
        "content": "A group of six accounts has posted reviews for the same property over a two-week period. The accounts were created at different times, but they have similar profile details, similar writing styles, and frequently interact with each other’s reviews. Some accounts have verified bookings, while others do not.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which principle should guide the decision?",
    "options": [
      {
        "letter": "A",
        "text": "Similarity alone confirms misconduct.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Account connections should always be ignored.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Multiple indicators should be considered together before action is taken.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Verified bookings eliminate all concerns.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 104,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 26",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q105",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-27",
    "case_title": "Customer Complaint Against a Popular Property",
    "tabs": [
    {
        "name": "Case File",
        "content": "A highly rated property receives a complaint from a traveler claiming that the listing description was inaccurate. The property has thousands of positive reviews, and the owner states that one complaint should not affect their reputation.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which factor should have the greatest influence on the assessment?",
    "options": [
      {
        "letter": "A",
        "text": "The property’s high rating.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The number of positive reviews.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Whether the complaint is supported by available evidence.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The owner’s reputation.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 105,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 27",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q106",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-27",
    "case_title": "Customer Complaint Against a Popular Property",
    "tabs": [
    {
        "name": "Case File",
        "content": "A highly rated property receives a complaint from a traveler claiming that the listing description was inaccurate. The property has thousands of positive reviews, and the owner states that one complaint should not affect their reputation.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which factors are relevant when evaluating the complaint?",
    "options": [
      {
        "letter": "A",
        "text": "Accuracy of the listing information",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Details provided by the traveler",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Information available at the time of booking",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Property popularity",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 106,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 27",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q107",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-27",
    "case_title": "Customer Complaint Against a Popular Property",
    "tabs": [
    {
        "name": "Case File",
        "content": "A highly rated property receives a complaint from a traveler claiming that the listing description was inaccurate. The property has thousands of positive reviews, and the owner states that one complaint should not affect their reputation.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which assumption should be avoided?",
    "options": [
      {
        "letter": "A",
        "text": "Evidence should guide decisions.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Individual complaints should be reviewed fairly.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Popular properties cannot have accuracy issues.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Previous success does not guarantee future compliance.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 107,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 27",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q108",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-27",
    "case_title": "Customer Complaint Against a Popular Property",
    "tabs": [
    {
        "name": "Case File",
        "content": "A highly rated property receives a complaint from a traveler claiming that the listing description was inaccurate. The property has thousands of positive reviews, and the owner states that one complaint should not affect their reputation.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which decision best demonstrates fair judgment?",
    "options": [
      {
        "letter": "A",
        "text": "Reject the complaint because the property has good reviews.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Remove the property because one complaint was received.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Evaluate the specific concern without being influenced by popularity.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Always support the traveler.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 108,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 27",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q109",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-28",
    "case_title": "Review With Contradictory Information",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler posts a review stating that a property had no parking facilities. The property owner disputes this and provides evidence that parking was available. The listing at the time of booking mentioned parking, but the traveler claims they were unable to use it during their stay.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What makes this case difficult to assess?",
    "options": [
      {
        "letter": "A",
        "text": "The traveler left a negative review.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The property owner disagrees.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The available information presents different perspectives of the same experience.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property provides parking.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 109,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 28",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q110",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-28",
    "case_title": "Review With Contradictory Information",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler posts a review stating that a property had no parking facilities. The property owner disputes this and provides evidence that parking was available. The listing at the time of booking mentioned parking, but the traveler claims they were unable to use it during their stay.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which factors should be considered when evaluating this case?",
    "options": [
      {
        "letter": "A",
        "text": "What information was displayed during booking",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "The traveler’s actual experience",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The evidence provided by the property",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The property rating",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 110,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 28",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q111",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-28",
    "case_title": "Review With Contradictory Information",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler posts a review stating that a property had no parking facilities. The property owner disputes this and provides evidence that parking was available. The listing at the time of booking mentioned parking, but the traveler claims they were unable to use it during their stay.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement is most accurate?",
    "options": [
      {
        "letter": "A",
        "text": "The traveler must be wrong because parking was listed.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The property must be wrong because the traveler complained.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "A listing feature being available does not always mean the customer experience matched expectations.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Negative reviews should always be removed.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 111,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 28",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q112",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-28",
    "case_title": "Review With Contradictory Information",
    "tabs": [
    {
        "name": "Case File",
        "content": "A traveler posts a review stating that a property had no parking facilities. The property owner disputes this and provides evidence that parking was available. The listing at the time of booking mentioned parking, but the traveler claims they were unable to use it during their stay.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which decision reflects balanced reasoning?",
    "options": [
      {
        "letter": "A",
        "text": "Support the property because evidence was provided.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Support the traveler because they experienced an issue.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Consider both the advertised information and actual experience before deciding.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Ignore the complaint because the feature existed.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 112,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 28",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q113",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-29",
    "case_title": "Unusual Review Timing",
    "tabs": [
    {
        "name": "Case File",
        "content": "A reviewer posts a negative review one day after a property owner receives a dispute related to the same booking. The property owner claims the review was posted as retaliation. The reviewer has a verified booking and has written similar reviews for other properties.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the key challenge in this case?",
    "options": [
      {
        "letter": "A",
        "text": "The review is negative.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The property owner reported the review.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Determining whether the review reflects a genuine experience or retaliatory behavior.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The review was posted quickly.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 113,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 29",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q114",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-29",
    "case_title": "Unusual Review Timing",
    "tabs": [
    {
        "name": "Case File",
        "content": "A reviewer posts a negative review one day after a property owner receives a dispute related to the same booking. The property owner claims the review was posted as retaliation. The reviewer has a verified booking and has written similar reviews for other properties.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which details support the possibility that the review is genuine?",
    "options": [
      {
        "letter": "A",
        "text": "Verified booking",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similar review behavior across other properties",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "The review was posted after a dispute",
        "is_correct": false
      },
      {
        "letter": "D",
        "text": "The property owner disagrees",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 114,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 29",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q115",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-29",
    "case_title": "Unusual Review Timing",
    "tabs": [
    {
        "name": "Case File",
        "content": "A reviewer posts a negative review one day after a property owner receives a dispute related to the same booking. The property owner claims the review was posted as retaliation. The reviewer has a verified booking and has written similar reviews for other properties.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which conclusion is best supported by the evidence?",
    "options": [
      {
        "letter": "A",
        "text": "The review is retaliatory because of the timing.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "The review is genuine because the booking exists.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Timing alone does not confirm intent; all available evidence should be considered.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "The review should automatically be removed.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 115,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 29",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q116",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-29",
    "case_title": "Unusual Review Timing",
    "tabs": [
    {
        "name": "Case File",
        "content": "A reviewer posts a negative review one day after a property owner receives a dispute related to the same booking. The property owner claims the review was posted as retaliation. The reviewer has a verified booking and has written similar reviews for other properties.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which assumption should be avoided?",
    "options": [
      {
        "letter": "A",
        "text": "Timing can be a relevant factor.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Genuine customers may leave negative feedback.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "A review posted after a dispute is always retaliatory.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Multiple factors should be considered together.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 116,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 29",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q117",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-30",
    "case_title": "High-Risk Case With Conflicting Indicators",
    "tabs": [
    {
        "name": "Case File",
        "content": "A newly created account posts several reviews within a short period. The reviews are detailed and linked to verified bookings. However, the account shares a device with other accounts involved in suspicious activity, and the reviews contain similar phrases.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "What is the most accurate risk assessment?",
    "options": [
      {
        "letter": "A",
        "text": "Low risk because bookings are verified.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "High risk because the account is new.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "The case contains multiple risk indicators along with legitimate signals.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "No concern exists because the reviews are detailed.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 117,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 30",
      "number": 1
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q118",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-30",
    "case_title": "High-Risk Case With Conflicting Indicators",
    "tabs": [
    {
        "name": "Case File",
        "content": "A newly created account posts several reviews within a short period. The reviews are detailed and linked to verified bookings. However, the account shares a device with other accounts involved in suspicious activity, and the reviews contain similar phrases.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_multi",
    "stem": "Which details increase the risk level?",
    "options": [
      {
        "letter": "A",
        "text": "Shared device connection with suspicious accounts",
        "is_correct": true
      },
      {
        "letter": "B",
        "text": "Similar phrases across reviews",
        "is_correct": true
      },
      {
        "letter": "C",
        "text": "Multiple reviews from a newly created account",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Verified bookings",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 118,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 30",
      "number": 2
    },
    "difficulty_tier": "complex"
  },
  {
    "id": "cri-risk-assessment-q119",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-30",
    "case_title": "High-Risk Case With Conflicting Indicators",
    "tabs": [
    {
        "name": "Case File",
        "content": "A newly created account posts several reviews within a short period. The reviews are detailed and linked to verified bookings. However, the account shares a device with other accounts involved in suspicious activity, and the reviews contain similar phrases.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which statement best reflects good decision-making?",
    "options": [
      {
        "letter": "A",
        "text": "Any suspicious indicator confirms fraud.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Any verified booking removes all concerns.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Both positive and negative evidence should be weighed before reaching a decision.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "New accounts should always be treated as risky.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 119,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 30",
      "number": 3
    },
    "difficulty_tier": "straightforward"
  },
  {
    "id": "cri-risk-assessment-q120",
    "bank": "critical",
    "section": "risk_assessment",
    "level": null,
    "case_id": "ct-case-30",
    "case_title": "High-Risk Case With Conflicting Indicators",
    "tabs": [
    {
        "name": "Case File",
        "content": "A newly created account posts several reviews within a short period. The reviews are detailed and linked to verified bookings. However, the account shares a device with other accounts involved in suspicious activity, and the reviews contain similar phrases.",
        "position": 1
    }
],
    "tables": null,
    "response_type": "mcq_single",
    "stem": "Which business decision best balances trust and risk prevention?",
    "options": [
      {
        "letter": "A",
        "text": "Remove all reviews immediately.",
        "is_correct": false
      },
      {
        "letter": "B",
        "text": "Approve all reviews because they contain details.",
        "is_correct": false
      },
      {
        "letter": "C",
        "text": "Assess the complete evidence before deciding whether action is required.",
        "is_correct": true
      },
      {
        "letter": "D",
        "text": "Ignore the account history.",
        "is_correct": false
      }
    ],
    "model_answer": null,
    "position": 120,
    "source": {
      "file": "FS Question Bank_Critical Thinking V2.docx",
      "section": "CASE 30",
      "number": 4
    },
    "difficulty_tier": "straightforward"
  }
];
