// Cloudflare D1'in çok küçük, bellek-içi bir taklidi — sadece
// src/index.js'in gerçekten ürettiği sorgu kalıplarını destekler.
// wrangler dev'e (ağ erişimi / gerçek Cloudflare hesabı gerektirir) ihtiyaç
// duymadan iş mantığını (streak hesaplama, rate limiting, leaderboard
// sıralaması, cookie imzalama) doğrulamak için kullanılır.

export function createMockD1() {
  const sessions = new Map(); // id -> session row
  const leaderboard = new Map(); // session_id -> entry row
  const ipHits = []; // { ip, ts }

  function makeStatement(sql, boundArgs) {
    return {
      bind(...args) {
        return makeStatement(sql, args);
      },
      async first() {
        return execFirst(sql, boundArgs);
      },
      async all() {
        return execAll(sql, boundArgs);
      },
      async run() {
        return execRun(sql, boundArgs);
      },
    };
  }

  function execFirst(sql, args) {
    if (sql.includes("SELECT * FROM game_session WHERE id")) {
      const row = sessions.get(args[0]);
      return row ? { ...row } : null;
    }
    if (sql.includes("SELECT COUNT(*) as c FROM ip_hit")) {
      const ip = args[0];
      const c = ipHits.filter((h) => h.ip === ip).length;
      return { c };
    }
    if (sql.includes("SELECT COUNT(*) as c FROM leaderboard_entry")) {
      return { c: leaderboard.size };
    }
    if (sql.includes("SELECT score FROM leaderboard_entry ORDER BY score ASC")) {
      const rows = [...leaderboard.values()].sort((a, b) => a.score - b.score);
      return rows[0] ? { score: rows[0].score } : null;
    }
    if (sql.includes("SELECT * FROM leaderboard_entry WHERE session_id")) {
      const row = leaderboard.get(args[0]);
      return row ? { ...row } : null;
    }
    throw new Error("MockD1: unhandled first() query: " + sql);
  }

  function execAll(sql, args) {
    if (sql.includes("FROM leaderboard_entry le") && sql.includes("JOIN game_session")) {
      const limit = args[0];
      const rows = [...leaderboard.entries()]
        .filter(([sessionId]) => {
          const gs = sessions.get(sessionId);
          return gs && !gs.flagged;
        })
        .map(([, entry]) => entry)
        .sort((a, b) => b.score - a.score || (a.achieved_at < b.achieved_at ? -1 : 1))
        .slice(0, limit);
      return { results: rows };
    }
    throw new Error("MockD1: unhandled all() query: " + sql);
  }

  function execRun(sql, args) {
    if (sql.includes("INSERT INTO game_session")) {
      const [id, now, ipHash] = args;
      sessions.set(id, {
        id,
        current_index: 0,
        current_streak: 0,
        best_streak: 0,
        total_rolls: 0,
        created_at: now,
        last_roll_at: null,
        ip_hash: ipHash,
        flagged: 0,
      });
      return { success: true };
    }
    if (sql.includes("UPDATE game_session")) {
      const [currentIndex, currentStreak, bestStreak, lastRollAt, id] = args;
      const row = sessions.get(id);
      if (row) {
        row.current_index = currentIndex;
        row.current_streak = currentStreak;
        row.best_streak = bestStreak;
        row.total_rolls += 1;
        row.last_roll_at = lastRollAt;
      }
      return { success: true };
    }
    if (sql.includes("DELETE FROM ip_hit")) {
      const [ip, windowStart] = args;
      for (let i = ipHits.length - 1; i >= 0; i--) {
        if (ipHits[i].ip === ip && ipHits[i].ts < windowStart) ipHits.splice(i, 1);
      }
      return { success: true };
    }
    if (sql.includes("INSERT INTO ip_hit")) {
      const [ip, ts] = args;
      ipHits.push({ ip, ts });
      return { success: true };
    }
    if (sql.includes("INSERT INTO leaderboard_entry")) {
      const [sessionId, nickname, score, achievedAt] = args;
      leaderboard.set(sessionId, { session_id: sessionId, nickname, score, achieved_at: achievedAt });
      return { success: true };
    }
    if (sql.includes("UPDATE leaderboard_entry SET score")) {
      const [score, nickname, achievedAt, sessionId] = args;
      const row = leaderboard.get(sessionId);
      if (row) {
        row.score = score;
        row.nickname = nickname;
        row.achieved_at = achievedAt;
      }
      return { success: true };
    }
    throw new Error("MockD1: unhandled run() query: " + sql);
  }

  return {
    prepare(sql) {
      return makeStatement(sql, []);
    },
    // Test yardımcıları — gerçek D1 API'sinin parçası değil.
    _debug: { sessions, leaderboard, ipHits },
  };
}
