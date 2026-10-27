// Thai translations for user-visible messages produced by the server (lib/*.mjs).
// Each entry: [englishTemplate, thaiTemplate]. {0}, {1}, ... are interpolated parts,
// numbered in order of appearance in the English. More specific templates come first
// so that, with first-match-wins lookup, they win over shorter variants.
export const SERVER_TH = [
  ["{0} REST requests came without headers / body (Postman had not loaded them) — open them in Postman and import again to get the rest", "request แบบ REST {0} ตัวมาโดยไม่มี header / body (Postman ยังไม่ได้โหลดไว้) — เปิดใน Postman แล้ว import ใหม่เพื่อเอาส่วนที่เหลือ"],
  ["{0}: {1} moved to secrets.local.yaml as {2}", "{0}: ย้าย {1} ไปเก็บใน secrets.local.yaml ชื่อ {2}"],
  ["{0}: form-data body is not supported — left out", "{0}: body แบบ form-data ยังไม่รองรับ — ไม่ได้นำเข้า"],
  // lib/auth.mjs
  ['Auth uses variables that are not set: {0} — set them in the env or switch Authorization to "Inherit from collection"', 'auth ใช้ตัวแปรที่ยังไม่ได้ตั้ง: {0} — ตั้งค่าใน env หรือเปลี่ยน Authorization เป็น "ใช้ของ collection"'],

  // lib/builder.mjs
  ['Fix the query first (it does not parse yet), then tick fields', 'แก้ query ให้ถูกก่อน (ยัง parse ไม่ได้) แล้วค่อยติ๊ก field'],
  ['Field "{0}" not found in schema', 'ไม่มี field "{0}" ใน schema'],
  ['Argument "{0}" not found on {1}', 'ไม่มี argument "{0}" ใน {1}'],
  ['Fix the query first (it does not parse yet)', 'แก้ query ให้ถูกก่อน (ยัง parse ไม่ได้)'],

  // lib/flow.mjs
  ['Enter a flow name', 'ใส่ชื่อ flow'],
  ['(no request)', '(ไม่มี request)'],
  ['File not found: {0}', 'ไม่พบไฟล์ {0}'],

  // lib/grpc.mjs
  ['Service {0} not found in {1}', 'ไม่พบ service {0} ใน {1}'],
  ['Method {0}/{1} not found', 'ไม่พบ method {0}/{1}'],
  ['{0}/{1} — waiting for messages', '{0}/{1} — รอข้อความ'],
  ['Stream ended ({0} ms)', 'stream จบ ({0} ms)'],
  ['This method does not accept more messages (server streaming)', 'method นี้ไม่รับข้อความเพิ่ม (server streaming)'],

  // lib/import-paste.mjs
  ['Not a curl command', 'ไม่ใช่คำสั่ง curl'],
  ['No URL found in the curl command', 'ไม่พบ URL ในคำสั่ง curl'],
  ['Invalid GraphQL: {0}', 'GraphQL ไม่ถูกต้อง: {0}'],
  ['Choose a collection to import into', 'เลือก collection ที่จะใส่'],
  ['Paste a cURL command or GraphQL query first', 'วาง cURL หรือ GraphQL query ก่อน'],
  ['Bearer token saved in envs/{0}.local.env.yaml as BEARER_TOKEN (not in the request file)', 'Bearer token เก็บใน envs/{0}.local.env.yaml เป็น BEARER_TOKEN (ไม่อยู่ในไฟล์ request)'],
  ['Set GQL_URL for env {0} = {1}', 'ตั้ง GQL_URL ของ env {0} = {1}'],
  ['Set {0} for env {1} = {2}', 'ตั้ง {0} ของ env {1} = {2}'],
  ['Pasted URL ({0}) differs from {1} of {2} ({3}) — using the env value', 'URL ที่วาง ({0}) ต่างจาก {1} ของ {2} ({3}) — ใช้ของ env'],

  // lib/import-postman-desktop.mjs
  ['Tokens embedded in requests were removed (they have expired and should not be in files) — use Keycloak login or paste a token in the Authorization tab', 'token ที่ฝังอยู่ใน request ถูกตัดออก (หมดอายุแล้วและไม่ควรอยู่ในไฟล์) — ใช้ Keycloak login หรือวาง token ในแท็บ Authorization'],
  ['{0}: auth type {1} is not converted yet — using the collection auth instead', '{0}: auth แบบ {1} ยังไม่ได้แปลง — ใช้ auth ของ collection แทน'],
  ['Authorization headers containing real tokens were removed — use Keycloak login or paste a token in the Authorization tab', 'Authorization header ที่มี token จริงถูกตัดออก — ใช้ Keycloak login หรือวาง token ในแท็บ Authorization'],
  ['{0}: variables are not JSON — left empty', '{0}: variables ไม่ใช่ JSON — ปล่อยว่าง'],
  ['{0} requests in Postman use {1}', '{0} request ใน Postman ใช้ {1}'],
  ['Every request uses the URL of the selected env ({{GQL_URL}}) — set the URL for prod or other envs in the URL field on the red bar', 'ทุก request ใช้ URL ของ env ที่เลือก ({{GQL_URL}}) — ตั้ง URL ของ prod / env อื่นได้ที่ช่อง URL ในแถบแดง'],
  ['Queries with a token or 13-digit ID number written inline (switch to variables before committing): {0}', 'query ที่มี token หรือเลขบัตร 13 หลักเขียนตรงในข้อความ (ควรเปลี่ยนเป็นตัวแปรก่อน commit): {0}'],

  // lib/realtime.mjs
  ['Socket.IO connected to {0} (namespace {1})', 'เชื่อมต่อ Socket.IO แล้ว {0} (namespace {1})'],
  ['Socket.IO connected to {0}', 'เชื่อมต่อ Socket.IO แล้ว {0}'],
  ['Connected to {0}', 'เชื่อมต่อแล้ว {0}'],
  ['Connection closed (code {0}, {1})', 'ปิดการเชื่อมต่อ (code {0}, {1})'],
  ['Connection closed (code {0})', 'ปิดการเชื่อมต่อ (code {0})'],
  ['Not connected', 'ยังไม่ได้เชื่อมต่อ'],
  ['Connection failed: {0}', 'เชื่อมต่อไม่ได้: {0}'],
  ['Server disconnected the namespace', 'server ตัดการเชื่อมต่อ namespace'],

  // lib/runner.mjs
  ['{0} is a persistent connection — open it in the app and press Connect (not supported in flow / hyperion run)', '{0} เป็นการเชื่อมต่อค้างไว้ — เปิดในแอปแล้วกด Connect (ใช้ใน flow / hyperion run ไม่ได้)'],

  ['SOAP Fault: {0} — {1}', 'SOAP Fault: {0} — {1}'],

  // lib/wsdl.mjs
  ['Enter the WSDL URL or file path first', 'ใส่ URL หรือ path ของไฟล์ WSDL ก่อน'],
  ['Could not load WSDL {0}: HTTP {1}', 'โหลด WSDL {0} ไม่ได้: HTTP {1}'],
  ['Could not load WSDL {0}: file not found', 'โหลด WSDL {0} ไม่ได้: ไม่พบไฟล์'],
  ['Could not load WSDL {0}: empty document', 'โหลด WSDL {0} ไม่ได้: เอกสารว่าง'],
  ['Could not load WSDL {0}: not an XML schema (root element is <{1}>)', 'โหลด WSDL {0} ไม่ได้: ไม่ใช่ XML schema (root element คือ <{1}>)'],
  ['Could not load WSDL {0}: {1}', 'โหลด WSDL {0} ไม่ได้: {1}'],
  ['Schema not loaded (nested too deep): {0}', 'ไม่ได้โหลด schema (ซ้อนลึกเกินไป): {0}'],
  ["WSDL 2.0 is not supported — use the service's WSDL 1.1 (often ?wsdl instead of ?wsdl2)", 'ยังไม่รองรับ WSDL 2.0 — ใช้ WSDL 1.1 ของ service (มักเป็น ?wsdl แทน ?wsdl2)'],
  ['Not a WSDL: the root element is <{0}>', 'ไม่ใช่ WSDL: root element คือ <{0}>'],
  ['No SOAP service found in the WSDL', 'ไม่พบ SOAP service ใน WSDL'],

  // lib/server.mjs
  ['hyperion.yaml not found in {0} — use "New project" instead', 'ไม่พบ hyperion.yaml ใน {0} — ใช้ "สร้างโปรเจกต์ใหม่" แทน'],
  ['Enter the folder path', 'ใส่ path ของโฟลเดอร์'],
  ['Choose a service / method first', 'เลือก service / method ก่อน'],
  ['This connection is already closed — press Connect again', 'การเชื่อมต่อนี้ปิดไปแล้ว — กด Connect ใหม่'],
  ['Enter the .proto file path first', 'ใส่ path ของไฟล์ .proto ก่อน'],
  ['No schema yet — press Sync schema first', 'ยังไม่มี schema — กด Sync schema ก่อน'],
  ['No schema yet', 'ยังไม่มี schema'],
  ['Not a collection', 'ไม่ใช่ collection'],
  ['Variable names may only use A-Z 0-9 _', 'ชื่อตัวแปรใช้ได้แค่ A-Z 0-9 _'],
  ['No host selected', 'ยังไม่ได้เลือก host'],
  ['Not a request file', 'ไม่ใช่ไฟล์ request'],
  ['Collection "{0}" not found in Postman desktop', 'ไม่พบ collection "{0}" ใน Postman desktop'],
  ['No Postman desktop data found on this machine', 'ไม่พบข้อมูล Postman desktop ในเครื่องนี้'],
  ['Invalid variable name: "{0}"', 'ชื่อตัวแปรไม่ถูกต้อง: "{0}"'],
  ['Invalid variable name', 'ชื่อตัวแปรไม่ถูกต้อง'],
  ['{0} must be JSON ({1})', '{0} ต้องเป็น JSON ({1})'],
  ['{0} uses variables not set in env {1}: {2}', '{0} ใช้ตัวแปรที่ยังไม่ได้ตั้งใน env {1}: {2}'],
  ['Enter a URL first', 'ใส่ URL ก่อน'],
  ['Connection not found', 'ไม่พบการเชื่อมต่อ'],
  ['No project is open', 'ยังไม่ได้เปิดโปรเจกต์'],
];
