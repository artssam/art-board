import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BUCKET = "board-artworks";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

class Fail extends Error {
  code: string;
  constructor(msg: string, code = "bad") { super(msg); this.code = code; }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const enc = new TextEncoder();
const toHex = (a: Uint8Array) => [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
const randHex = (n: number) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return toHex(a); };
const randPin = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return String(a[0] % 10000).padStart(4, "0"); };
const clean = (v: unknown) => String(v ?? "").replace(/\s/g, "");
// 화면(index.html)의 classOf와 같은 규칙: 5자리 학번 20701 → "2-7"
const classOf = (id: string) => id.length === 5 ? id[0] + "-" + parseInt(id.slice(1, 3), 10) : "기타";

async function setting(key: string) {
  const { data } = await db.from("board_settings").select("value").eq("key", key).single();
  return data?.value ?? "";
}
const pinHash = async (sid: string, pin: string) => sha256((await setting("pin_pepper")) + ":" + sid + ":" + pin);
// 교사 확인: 비밀번호가 아니라 teacher_login이 발급한 세션 토큰(tt)으로 해요.
async function isTeacher(tt: unknown) {
  if (!tt) return false;
  const { data } = await db.from("board_teacher_sessions").select("expires_at").eq("token_hash", await sha256(String(tt))).maybeSingle();
  return !!data && new Date(data.expires_at) > new Date();
}
const setSetting = (key: string, value: string) => db.from("board_settings").upsert({ key, value });
async function me(token: unknown) {
  if (!token) throw new Fail("다시 로그인해 주세요.", "auth");
  const { data } = await db.from("board_sessions")
    .select("student_id, expires_at, board_students(name)")
    .eq("token_hash", await sha256(String(token))).maybeSingle();
  if (!data || new Date(data.expires_at) < new Date()) throw new Fail("다시 로그인해 주세요.", "auth");
  // deno-lint-ignore no-explicit-any
  return { sid: data.student_id as string, name: (data as any).board_students?.name as string };
}
async function checkUpload(sid: string, image: unknown, thumb: unknown) {
  const m = /^(\d{4,6}|teacher)\/([0-9a-f-]{36})\.jpg$/.exec(String(image ?? ""));
  if (!m || m[1] !== sid || thumb !== `${sid}/${m[2]}_t.jpg`) throw new Fail("사진 정보가 올바르지 않아요.");
  const { data: files } = await db.storage.from(BUCKET).list(sid, { search: m[2] });
  if (!files || files.length < 2) throw new Fail("사진이 다 올라가지 않았어요. 다시 올려 주세요.");
}
async function config(key: string) {
  const { data } = await db.from("board_config").select("value").eq("key", key).maybeSingle();
  return data?.value ?? "";
}
const FLAGS = ["cross_class_view", "shared_device"];
const cut = (v: unknown, n: number) => String(v ?? "").replace(/\r\n/g, "\n").trim().slice(0, n);
async function openAssignment(id: unknown, mustBeOpen: boolean) {
  const { data } = await db.from("board_assignments").select("id, open").eq("id", String(id ?? "")).maybeSingle();
  if (!data) throw new Fail("과제를 골라 주세요.");
  if (mustBeOpen && !data.open) throw new Fail("마감된 과제예요. 진행 중인 과제를 골라 주세요.");
  return data.id as string;
}
function checkPin(pin: string) {
  if (!/^\d{4,6}$/.test(pin)) throw new Fail("PIN은 숫자 4~6자리로 정해 주세요.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json();
    const teacher = await isTeacher(b.tt);
    const needTeacher = () => { if (!teacher) throw new Fail("교사 로그인이 끝났어요. 다시 들어와 주세요.", "teacher"); };

    switch (b.action) {
      case "feed": {
        // 작품·댓글은 이 요청으로만 내려가요. 교사는 전부, 학생은 자기 반(허용되면 전체), 로그인 전에는 없음.
        const [pr, cr, gr, ar] = await Promise.all([
          db.from("board_posts").select("*").order("created_at", { ascending: false }),
          db.from("board_comments").select("*").order("created_at"),
          db.from("board_config").select("key, value"),
          db.from("board_assignments").select("*").order("created_at"),
        ]);
        if (pr.error || cr.error) throw new Fail("게시판을 불러오지 못했어요. 잠시 뒤 다시 해 주세요.");
        const posts = pr.data ?? [], comments = cr.data ?? [];
        const cfg = (k: string) => (gr.data ?? []).find((r) => r.key === k)?.value ?? "";
        const crossClass = cfg("cross_class_view") === "1";
        let visible: typeof posts = [], viewer = "";
        if (teacher) visible = posts;
        else if (b.token) {
          const u = await me(b.token);
          const mine = classOf(u.sid);
          viewer = u.sid;
          // 교사 게시물(예시·공지)은 모든 반에 보이고, 학생 작품은 자기 반만 (교사가 허용하면 전체).
          visible = posts.filter((p) => p.author_role === "teacher" || crossClass || classOf(p.student_id) === mine);
        }
        const byId = new Map(visible.map((p) => [p.id, p]));
        // 본인만 피드백: 교사와 그 작품의 주인에게만 내려가요.
        const shown = comments.filter((c) => {
          const p = byId.get(c.post_id);
          if (!p) return false;
          return c.visibility !== "private" || teacher || (viewer !== "" && p.student_id === viewer);
        });
        return json({
          posts: visible,
          comments: shown,
          assignments: teacher || viewer ? (ar.data ?? []) : [],
          crossClass,
          sharedDevice: cfg("shared_device") === "1",
          snippets: teacher ? (() => { try { return JSON.parse(cfg("feedback_snippets") || "[]"); } catch { return []; } })() : [],
          // 로그인 첫 화면 배경: 다른 반 보기가 켜져 있을 때만 작품 썸네일을 보여 줘요.
          mosaic: crossClass ? posts.filter((p) => p.author_role === "student").slice(0, 14).map((p) => p.thumb_path) : [],
        });
      }

      case "student_login": {
        const sid = clean(b.studentId), name = clean(b.name), pin = String(b.pin ?? "");
        const { data: st } = await db.from("board_students").select("*").eq("student_id", sid).maybeSingle();
        if (!st || st.name !== name) throw new Fail("명단에 없는 학번·이름이에요. 선생님께 확인해 주세요.");
        if (st.locked_until && new Date(st.locked_until) > new Date()) throw new Fail("PIN을 여러 번 틀려서 잠겼어요. 5분 뒤에 다시 해 주세요.");
        if (st.pin_hash !== (await pinHash(sid, pin))) {
          const fc = st.fail_count + 1;
          await db.from("board_students").update(
            fc >= 5 ? { fail_count: 0, locked_until: new Date(Date.now() + 5 * 60e3).toISOString() } : { fail_count: fc },
          ).eq("student_id", sid);
          throw new Fail(fc >= 5 ? "PIN을 5번 틀려서 5분 동안 잠겼어요." : `PIN이 맞지 않아요. (${fc}/5)`);
        }
        await db.from("board_students").update({ fail_count: 0, locked_until: null }).eq("student_id", sid);
        await db.from("board_sessions").delete().lt("expires_at", new Date().toISOString());
        const token = randHex(32);
        // 공용 기기 모드면 2시간, 아니면 60일 동안 로그인이 유지돼요.
        const keep = (await config("shared_device")) === "1" ? 2 * 3600e3 : 60 * 86400e3;
        const expiresAt = new Date(Date.now() + keep).toISOString();
        await db.from("board_sessions").insert({ token_hash: await sha256(token), student_id: sid, expires_at: expiresAt });
        return json({ token, studentId: sid, name: st.name, mustChange: !!st.must_change, expiresAt });
      }
      case "set_pin": {
        const u = await me(b.token);
        const pin = String(b.newPin ?? "");
        checkPin(pin);
        await db.from("board_students").update({ pin_hash: await pinHash(u.sid, pin), init_pin: null, must_change: false }).eq("student_id", u.sid);
        return json({ ok: true });
      }
      case "logout": {
        if (b.token) await db.from("board_sessions").delete().eq("token_hash", await sha256(String(b.token)));
        return json({ ok: true });
      }

      case "upload_urls": {
        const dir = b.asTeacher ? (needTeacher(), "teacher") : (await me(b.token)).sid;
        const id = crypto.randomUUID();
        const out: Record<string, { path: string; token: string }> = {};
        for (const [k, path] of [["full", `${dir}/${id}.jpg`], ["thumb", `${dir}/${id}_t.jpg`]]) {
          const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
          if (error || !data) throw new Fail("사진 올릴 준비를 하지 못했어요. 다시 해 주세요.");
          out[k] = { path, token: data.token };
        }
        return json(out);
      }
      case "create_post": {
        const u = await me(b.token);
        const assignment_id = await openAssignment(b.assignmentId, true);
        await checkUpload(u.sid, b.image_path, b.thumb_path);
        const { error } = await db.from("board_posts").insert({
          student_id: u.sid, name: u.name, assignment_id,
          title: String(b.title ?? "").trim().slice(0, 60) || "무제",
          description: String(b.description ?? "").trim().slice(0, 1000),
          image_path: b.image_path, thumb_path: b.thumb_path,
        });
        if (error) throw new Fail("작품 정보를 저장하지 못했어요.");
        return json({ ok: true });
      }

      case "update_post": {
        // 내 작품의 제목·설명을 고치고, 원하면 사진도 바꿔요. 받은 댓글·피드백은 그대로 남아요.
        const { data: p } = await db.from("board_posts").select("*").eq("id", b.postId).maybeSingle();
        if (!p) throw new Fail("지워진 작품이에요.");
        let dir: string;
        if (p.author_role === "teacher") { needTeacher(); dir = "teacher"; }
        else { const u = await me(b.token); if (p.student_id !== u.sid) throw new Fail("내 작품만 고칠 수 있어요."); dir = u.sid; }
        const patch: Record<string, unknown> = {
          title: String(b.title ?? "").trim().slice(0, 60) || "무제",
          description: String(b.description ?? "").trim().slice(0, 1000),
          edited_at: new Date().toISOString(),
        };
        let old: string[] = [];
        if (b.image_path) {
          await checkUpload(dir, b.image_path, b.thumb_path);
          patch.image_path = b.image_path; patch.thumb_path = b.thumb_path;
          old = [p.image_path, p.thumb_path].filter(Boolean);
        }
        const { error } = await db.from("board_posts").update(patch).eq("id", p.id);
        if (error) throw new Fail("작품을 고치지 못했어요.");
        if (old.length) await db.storage.from(BUCKET).remove(old);
        return json({ ok: true });
      }

      case "create_teacher_post": {
        needTeacher();
        const assignment_id = await openAssignment(b.assignmentId, false);
        const title = cut(b.title, 60), description = cut(b.description, 1000);
        if (!title) throw new Fail("제목을 적어 주세요.");
        const row: Record<string, unknown> = { author_role: "teacher", assignment_id, title, description, pinned: b.pinned !== false };
        if (b.image_path) { await checkUpload("teacher", b.image_path, b.thumb_path); row.image_path = b.image_path; row.thumb_path = b.thumb_path; }
        else if (!description) throw new Fail("공지 내용을 적어 주세요.");
        const { error } = await db.from("board_posts").insert(row);
        if (error) throw new Fail("게시물을 저장하지 못했어요.");
        return json({ ok: true });
      }
      case "set_pinned": {
        needTeacher();
        const { error } = await db.from("board_posts").update({ pinned: !!b.pinned }).eq("id", b.postId);
        if (error) throw new Fail("고정을 바꾸지 못했어요.");
        return json({ ok: true });
      }

      case "student_comment": {
        const u = await me(b.token);
        const body = String(b.body ?? "").trim().slice(0, 500);
        if (!body) throw new Fail("댓글 내용을 적어 주세요.");
        const { data: p } = await db.from("board_posts").select("student_id, author_role").eq("id", b.postId).maybeSingle();
        if (!p) throw new Fail("지워진 작품이에요.");
        if (p.author_role === "teacher") throw new Fail("선생님 게시물에는 댓글을 달 수 없어요.");
        if (classOf(p.student_id) !== classOf(u.sid)) throw new Fail("다른 반 작품에는 댓글을 달 수 없어요.");
        const { error } = await db.from("board_comments").insert({ post_id: b.postId, role: "student", student_id: u.sid, name: u.name, body });
        if (error) throw new Fail("지워진 작품이에요.");
        return json({ ok: true });
      }
      case "teacher_comment": {
        needTeacher();
        const body = String(b.body ?? "").trim().slice(0, 500);
        if (!body) throw new Fail("피드백 내용을 적어 주세요.");
        const visibility = b.visibility === "private" ? "private" : "public";
        const { error } = await db.from("board_comments").insert({ post_id: b.postId, role: "teacher", body, visibility });
        if (error) throw new Fail("지워진 작품이에요.");
        return json({ ok: true });
      }

      case "edit_comment": {
        needTeacher();
        const { data: c } = await db.from("board_comments").select("id, role").eq("id", b.commentId).maybeSingle();
        if (!c) throw new Fail("지워진 피드백이에요.");
        if (c.role !== "teacher") throw new Fail("선생님 피드백만 고칠 수 있어요.");
        const body = String(b.body ?? "").trim().slice(0, 500);
        if (!body) throw new Fail("피드백 내용을 적어 주세요.");
        const patch: Record<string, unknown> = { body, edited_at: new Date().toISOString() };
        if (b.visibility === "private" || b.visibility === "public") patch.visibility = b.visibility;
        const { error } = await db.from("board_comments").update(patch).eq("id", c.id);
        if (error) throw new Fail("피드백을 고치지 못했어요.");
        return json({ ok: true });
      }
      case "set_snippets": {
        needTeacher();
        const list = (Array.isArray(b.list) ? b.list : []).map((x: unknown) => String(x ?? "").trim().slice(0, 200)).filter(Boolean).slice(0, 50);
        const { error } = await db.from("board_config").upsert({ key: "feedback_snippets", value: JSON.stringify(list), updated_at: new Date().toISOString() });
        if (error) throw new Fail("상용구를 저장하지 못했어요.");
        return json({ ok: true, list });
      }

      case "delete_post": {
        const { data: p } = await db.from("board_posts").select("*").eq("id", b.postId).maybeSingle();
        if (!p) throw new Fail("이미 지워진 작품이에요.");
        if (!teacher) { const u = await me(b.token); if (u.sid !== p.student_id) throw new Fail("내 작품만 지울 수 있어요."); }
        const files = [p.image_path, p.thumb_path].filter(Boolean);
        if (files.length) await db.storage.from(BUCKET).remove(files);
        await db.from("board_posts").delete().eq("id", p.id);
        return json({ ok: true });
      }
      case "delete_comment": {
        const { data: c } = await db.from("board_comments").select("*").eq("id", b.commentId).maybeSingle();
        if (!c) return json({ ok: true });
        if (!teacher) {
          const u = await me(b.token);
          if (c.role !== "student" || c.student_id !== u.sid) throw new Fail("내가 쓴 댓글만 지울 수 있어요.");
        }
        await db.from("board_comments").delete().eq("id", c.id);
        return json({ ok: true });
      }

      case "teacher_login": {
        const until = await setting("teacher_locked_until");
        if (until && new Date(until) > new Date()) {
          const min = Math.ceil((new Date(until).getTime() - Date.now()) / 60e3);
          throw new Fail(`비밀번호를 5번 틀려서 잠겼어요. ${min}분 뒤에 다시 해 주세요.`);
        }
        if ((await setting("teacher_pw_sha256")) !== (await sha256(String(b.pw ?? "")))) {
          const fc = (parseInt(await setting("teacher_fail_count"), 10) || 0) + 1;
          if (fc >= 5) {
            await setSetting("teacher_fail_count", "0");
            await setSetting("teacher_locked_until", new Date(Date.now() + 10 * 60e3).toISOString());
            throw new Fail("비밀번호를 5번 틀려서 10분 동안 잠겼어요.");
          }
          await setSetting("teacher_fail_count", String(fc));
          throw new Fail(`교사 비밀번호가 맞지 않아요. (${fc}/5)`);
        }
        await setSetting("teacher_fail_count", "0");
        await setSetting("teacher_locked_until", "");
        await db.from("board_teacher_sessions").delete().lt("expires_at", new Date().toISOString());
        const tt = randHex(32);
        const expiresAt = new Date(Date.now() + (b.keep ? 7 * 86400e3 : 12 * 3600e3)).toISOString();
        await db.from("board_teacher_sessions").insert({ token_hash: await sha256(tt), expires_at: expiresAt });
        return json({ tt, expiresAt });
      }
      case "teacher_logout": {
        if (b.tt) await db.from("board_teacher_sessions").delete().eq("token_hash", await sha256(String(b.tt)));
        return json({ ok: true });
      }
      case "verify": needTeacher(); return json({ ok: true });
      case "change_pw": {
        needTeacher();
        const next = String(b.newPw ?? "");
        if (next.length < 6) throw new Fail("새 비밀번호는 6자 이상으로 정해 주세요.");
        await setSetting("teacher_pw_sha256", await sha256(next));
        // 다른 기기에 남아 있는 교사 로그인은 모두 끝내고, 지금 기기만 유지해요.
        await db.from("board_teacher_sessions").delete().neq("token_hash", await sha256(String(b.tt)));
        return json({ ok: true });
      }
      case "set_flag": {
        needTeacher();
        if (!FLAGS.includes(b.key)) throw new Fail("알 수 없는 설정이에요.");
        const { error } = await db.from("board_config").upsert({ key: b.key, value: b.on ? "1" : "0", updated_at: new Date().toISOString() });
        if (error) throw new Fail("설정을 바꾸지 못했어요.");
        return json({ ok: true });
      }
      case "save_assignment": {
        needTeacher();
        // 템플릿은 끝의 빈칸('■ 작품 의도: ')을 지키려고 앞뒤 공백을 자르지 않아요.
        const row = { title: cut(b.title, 40), template: String(b.template ?? "").replace(/\r\n/g, "\n").slice(0, 600), open: b.open !== false };
        if (!row.title) throw new Fail("과제 이름을 적어 주세요.");
        const q = b.id ? db.from("board_assignments").update(row).eq("id", b.id) : db.from("board_assignments").insert(row);
        const { error } = await q;
        if (error) throw new Fail("과제를 저장하지 못했어요.");
        return json({ ok: true });
      }
      case "delete_assignment": {
        needTeacher();
        const { count } = await db.from("board_posts").select("id", { count: "exact", head: true }).eq("assignment_id", b.id);
        if (count) throw new Fail(`이 과제에 게시물이 ${count}개 있어서 지울 수 없어요. 마감으로 바꿔 주세요.`);
        const { count: left } = await db.from("board_assignments").select("id", { count: "exact", head: true });
        if ((left ?? 0) <= 1) throw new Fail("과제는 하나 이상 있어야 해요.");
        const { error } = await db.from("board_assignments").delete().eq("id", b.id);
        if (error) throw new Fail("과제를 지우지 못했어요.");
        return json({ ok: true });
      }
      case "roster_list": {
        needTeacher();
        const { data } = await db.from("board_students").select("student_id, name, init_pin, must_change, locked_until").order("student_id");
        return json({ students: data ?? [] });
      }
      case "roster_import": {
        needTeacher();
        const rows: { studentId: string; name: string }[] = Array.isArray(b.rows) ? b.rows.slice(0, 1000) : [];
        const { data: existing } = await db.from("board_students").select("student_id");
        const have = new Set((existing ?? []).map((r) => r.student_id));
        const added: { studentId: string; name: string; pin: string }[] = [];
        const invalid: string[] = [];
        let skipped = 0;
        const inserts = [];
        for (const r of rows) {
          const sid = clean(r.studentId), name = clean(r.name);
          if (!/^\d{4,6}$/.test(sid) || name.length < 2 || name.length > 10) { invalid.push(`${r.studentId ?? ""} ${r.name ?? ""}`.trim()); continue; }
          if (have.has(sid)) { skipped++; continue; }
          have.add(sid);
          const pin = randPin();
          inserts.push({ student_id: sid, name, pin_hash: await pinHash(sid, pin), init_pin: pin, must_change: true });
          added.push({ studentId: sid, name, pin });
        }
        if (inserts.length) {
          const { error } = await db.from("board_students").insert(inserts);
          if (error) throw new Fail("명단을 저장하지 못했어요.");
        }
        return json({ added, skipped, invalid });
      }
      case "reset_pin": {
        needTeacher();
        const sid = clean(b.studentId);
        const pin = randPin();
        const { error } = await db.from("board_students")
          .update({ pin_hash: await pinHash(sid, pin), init_pin: pin, must_change: true, fail_count: 0, locked_until: null }).eq("student_id", sid);
        if (error) throw new Fail("PIN을 초기화하지 못했어요.");
        await db.from("board_sessions").delete().eq("student_id", sid);
        return json({ pin });
      }
      case "roster_delete": {
        needTeacher();
        await db.from("board_students").delete().eq("student_id", clean(b.studentId));
        return json({ ok: true });
      }

      default:
        throw new Fail("알 수 없는 요청이에요.");
    }
  } catch (e) {
    if (e instanceof Fail) return json({ error: e.message, code: e.code }, e.code === "auth" ? 401 : 400);
    console.error(e);
    return json({ error: "요청을 처리하지 못했어요. 잠시 뒤 다시 해 주세요." }, 500);
  }
});
