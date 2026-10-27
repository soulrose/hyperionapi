# Hyperion API

[English](README.md) · **ไทย**

ยิง GraphQL/REST ได้ทุกโปรเจกต์ — ถ้า env ไหนปิด introspection จะดึง schema จาก dev มาทำ autocomplete ให้ ต่ออายุ token อัตโนมัติ กันยิง mutation ใส่ prod และนำเข้าจาก Postman ได้

- **เบา:** Node.js ล้วน, ไม่มี build step, dependency น้อย (`yaml`, `graphql` และ `@grpc/*` สำหรับ gRPC), UI เปิดเป็นหน้าต่างของตัวเอง
- **Git-native:** โปรเจกต์คือโฟลเดอร์ YAML ธรรมดา — วางไว้ใน repo ของโปรเจกต์นั้นแล้ว commit/review ได้; token และ secret อยู่ในไฟล์ที่ gitignore

## เริ่มใช้

| ทางลัด | ทำอะไร |
| :--- | :--- |
| OffLab → **Hyperion API** (`start.bat`) | เปิด Hyperion เป็นหน้าต่างของตัวเอง (Edge app mode แบบ IssuePilot) กับโปรเจกต์ล่าสุดที่ใช้ — ไม่มีหน้าต่าง cmd; ปิดหน้าต่างแล้ว server หยุดเอง (log อยู่ที่ `server.log`); ครั้งแรกจะให้สร้างหรือเปิดโปรเจกต์ |
| ไอคอน **Hyperion API** บน Desktop | สร้างครั้งเดียวด้วย `npm run shortcut` (หรือ `node bin/hyperion.mjs shortcut`) — ดับเบิลคลิกแล้วเปิดเป็นหน้าต่างของตัวเอง ไม่ต้องเปิดเบราว์เซอร์หรือพิมพ์ URL |
| `npm start` | แบบเดียวกันจาก terminal (`serve --open`) — ใช้ได้ทุกระบบ |
| OffLab → ปุ่ม **demo** (`start-demo.bat`) | เปิด demo กับ API จำลอง (prod ปิด introspection + dev) ลองได้ทันที — demo เริ่มใหม่ทุกครั้งที่เปิด |

หน้าต่างจำขนาดและตำแหน่งล่าสุด (รวมถึงขยายเต็มจอ) แล้วเปิดครั้งหน้าแบบเดิม — เก็บที่ `%USERPROFILE%\.hyperion\window.json` · ใช้ได้แม้ Edge เปิดค้างอยู่เบื้องหลัง (Startup boost) ซึ่งไม่สน `--window-size` เพราะ Hyperion จัดหน้าต่างเองหลังเปิด
กดโลโก้ **Hyperion** มุมซ้ายบนเพื่อดู About (เวอร์ชัน, ผู้พัฒนา)

**ธีม:** Settings → **Theme**: Modern (ค่าเริ่มต้น แบบปัจจุบัน) หรือ Frutiger Aero (Vista) — กระจกบนพื้นท้องฟ้า ปุ่มมันวาว เปลี่ยนแล้วเห็นทันทีและจำไว้ · เพิ่มธีมใหม่: เขียน `public/themes/<id>.css` (rule อยู่ใต้ `html[data-theme="<id>"]`) แล้วเพิ่ม 1 บรรทัดในรายการที่ `public/themes.js`

**ฟอนต์:** หน้า **Settings** เดียวกันเลือกฟอนต์ของแอป, ขนาดตัวอักษร (90–125%), ฟอนต์โค้ด และขนาดโค้ดได้ — แสดงเฉพาะฟอนต์ที่มีในเครื่อง เปลี่ยนแล้วเห็นทันทีและจำไว้ · ถ้าฟอนต์ที่เลือกไม่มีภาษาไทย จะใช้ฟอนต์ไทยแทนเฉพาะตัวอักษรไทย

**ภาษา / Language:** UI เป็นภาษาอังกฤษเป็นค่าเริ่มต้น — เปลี่ยนเป็นไทยที่เมนูชื่อโปรเจกต์ → **Settings** → Language: ไทย (จำไว้ในเครื่อง) · ข้อความภาษาไทยอยู่ใน `public/i18n.js` (UI) และ `public/i18n-server.js` (ข้อความจาก server)

แก้อะไรก็บันทึกเอง: URL ในแถบแดง, query, variables, Authorization, Headers, flow, หน้าต่าง env และตั้งค่า collection — ไม่มีปุ่มบันทึก (Ctrl+S บันทึกทันที)

## หลายโปรเจกต์

- กดชื่อโปรเจกต์ข้างโลโก้ → เลือกโปรเจกต์ที่เคยเปิด, **เปิดโฟลเดอร์…** (วาง path ของโฟลเดอร์ที่มี `hyperion.yaml`) หรือ **สร้างโปรเจกต์ใหม่…**
- ปุ่มสร้างโปรเจกต์ใส่ค่าให้แล้ว: ชื่อ "My API" และโฟลเดอร์ `D:\OffLab\hyperion-projects\<ชื่อ>` (โฟลเดอร์เปลี่ยนตามชื่อที่พิมพ์ — เปลี่ยนที่ตั้งได้ด้วย env var `HYPERION_HOME`)
- โปรเจกต์ใหม่ได้ env `localhost` (URL `http://localhost:8080/graphql`), `dev`, `test`, `prod`, `training` (prod เป็น protected) และ collection `Main API` พร้อม request ตัวอย่าง — แก้ `GQL_URL` ใน `envs/*.env.yaml` แล้วยิงได้เลย
- **Settings → env:** เอาติ๊กออกเพื่อซ่อน env จากแถบบน (แยกตามโปรเจกต์ ในเครื่องนี้ ไฟล์ env ยังอยู่) · **เพิ่ม env** สร้าง env ใหม่ (เช่น `localhost` ในโปรเจกต์เก่า) จาก template เดียวกัน
- รายการโปรเจกต์เก็บที่ `%USERPROFILE%\.hyperion\projects.json` — ไม่มีไฟล์ของโปรเจกต์ไหนอยู่ในโฟลเดอร์ Hyperion

## Schema เมื่อ env ปิด introspection

schema โหลดเอง (ตอนเปิด request / เปลี่ยน env ถ้ายังไม่มีหรือเก่า และหลังแก้ URL) — ปุ่ม **sync ใหม่** ใช้บังคับโหลดใหม่ — ลองตามลำดับ:
1. env ปัจจุบันเอง (ลองครั้งเดียว ถ้าถูกปฏิเสธจะจำไว้ ไม่ยิงซ้ำ)
2. `SCHEMA_URL` ถ้า env นั้นตั้งไว้
3. **endpoint ของ env dev** ด้วยตัวแปรและ login ของ dev — ไม่ต้องตั้งอะไรเพิ่ม

ตอนเปิด request (ไม่ยิงเน็ต): ถ้า env นี้ยังไม่เคย sync จะยืม schema ที่ dev cache ไว้ ถ้า dev ไม่มีก็ใช้ของ env ที่ sync ล่าสุด — แถบ Schema บอกว่ายืมมาจาก env ไหน
เปลี่ยน env ต้นแบบได้ด้วย `schemaEnv: <ชื่อ env>` ใน `hyperion.yaml`

## ตั้ง URL, auth และ headers

- **URL ของ env** (เช่น dev host): พิมพ์ในช่อง URL ของแถบแดง "ยิงไปที่" ได้เลย — ถ้า request ใช้ `{{GQL_URL}}` จะบันทึกเป็น `GQL_URL` ของ env ที่เลือกอยู่ (ป้ายข้างช่องบอกว่าแก้ตัวแปรไหนของ env ไหน); ถ้า request มี URL ของตัวเองจะบันทึกลงไฟล์ request · ตัวแปรอื่นของ env แก้ที่ปุ่ม **แก้ env**
- **Auth และ headers ของ collection**: ชี้ที่ชื่อ collection แล้วกด **ตั้งค่า** → เลือก Auth (ไม่มี / Bearer / Basic / API Key / Login ต่ออายุอัตโนมัติ) และเพิ่ม Headers ที่ส่งทุก request
- **Auth แยกตาม env**: Auth ที่เลือกในหน้าตั้งค่าเป็นของ env ที่เลือกอยู่เท่านั้น — เช่น dev เลือก "ไม่มี" แล้ว test / prod ยังใช้ Keycloak เหมือนเดิม (บรรทัดบนของหน้าตั้งค่าบอกว่า env อื่นใช้อะไร) · ปุ่ม **ใช้ auth นี้กับทุก env** ทำให้ทุก env เหมือนกัน · ในไฟล์คือ `execution.auth` (ค่ากลาง) และ `execution.authByEnv.<env>` (ของ env นั้น)
- สลับชนิด Auth ไปมาได้ ค่าที่เคยใส่ (token, username, URL) จำไว้ใน `.hyperion/auth-stash.json` แล้วกลับมาเมื่อเลือกชนิดเดิม
- **Variables ของ collection**: หน้าตั้งค่า collection ส่วน Variables (แบบ Postman) — ใช้เป็น `{{ชื่อ}}` ได้ทุก request ในนั้น ค่าใน env ทับได้ · ปุ่ม **ดึงค่าจาก Postman** อ่าน current value ของ collection ชื่อเดียวกันจาก Postman desktop · ค่าที่ชื่อเป็น password / apiKey / token / cookie ถูกย้ายไป `secrets.local.yaml` อัตโนมัติ
- ใส่ค่าเป็นตัวแปร env ได้ เช่น Bearer token `{{TOKEN}}` แล้วตั้ง `TOKEN` ต่างกันในแต่ละ env ด้วย **แก้ env**; รหัสผ่านใส่เป็น `{{secret:NAME}}` แล้วเก็บค่าจริงใน `secrets.local.yaml`

## แท็บของ request (แบบ Postman)

- **Query** — ซ้ายเป็นรายการ field จาก schema (โหลดเอง): เปิด field แบบ object แล้วแถวแรก **ทุก field (n)** ติ๊ก/เอาติ๊กออกทุก field ธรรมดาข้างใน (object ข้างในมีแถวของตัวเอง); เปิด field ที่มี argument จะมีช่องกรอกค่า — พิมพ์แล้วค่าไปอยู่ใน Variables และ argument ถูกใส่ใน query เป็น $ตัวแปรเอง (argument ที่ไม่บังคับมี checkbox); ติ๊ก field แล้ว query ถูกเขียนให้, เอาติ๊กออก field ก็หายจาก query; argument ที่บังคับกลายเป็น `$ตัวแปร` และโผล่ใน Variables ให้เติมค่า; พิมพ์ query เองแล้วติ๊กก็ตามให้ · ปุ่ม **«** ย่อแผงเหลือแถบ "Schema" (กดเพื่อขยาย) · ลากขอบขวาเพื่อปรับความกว้าง (ดับเบิลคลิกคืนค่าเดิม)
- **Authorization** — ใช้ของ collection (ค่าเริ่มต้น), ไม่มี, Bearer Token, Basic, API Key — token ใส่เป็น `{{bearer_token}}` เพื่อใช้ค่าจาก env ได้
- **Headers** — header ของ request นี้ (ชื่อซ้ำกับของ collection จะทับ) และแสดง header ที่ได้จาก collection ให้ดู
- **Scripts** — เขียนได้ในแอป: **Pre-request** (ก่อนยิง เช่น `$req.headers.set(...)`) และ **Post-response (tests)** (`$test`, `$expect`, `$res.status`, `$res.json`, `$res.timeMs`, เก็บค่าด้วย `$env.set`) · ปุ่มตัวอย่าง: Status 200, ไม่มี error ของ GraphQL, มีข้อมูลกลับมา, เร็วกว่า 1 วินาที, เก็บค่าไว้ในตัวแปร · Send ใช้ script ตามที่แก้อยู่ และบันทึกลง `.req.yaml` เอง · แท็บ Tests ที่ยังว่างมีปุ่ม **Write a test**
- Send ใช้ค่าในแท็บทันทีแม้ยังไม่บันทึก · **บันทึกลงไฟล์** เขียน query, variables, auth และ headers ลง `.req.yaml`

## UI

- **แถบบนสุด** เลือก env — env ที่ `protected: true` (prod) มีแถบแดง "Production — ยิงไปที่ข้อมูลจริง" — กด Send ที่ mutation ของ GraphQL บน prod จะถาม **ตกลง / ยกเลิก** ก่อนยิง (env อื่น, query และ REST ยิงทันที); CLI ต้องใส่ `--confirm <OpName>`
- **ยิงไปที่** (แดง) = URL ที่ request จะไปจริง · **Schema จาก** (เหลือง) = schema ที่ใช้ทำ autocomplete มาจากไหน ดึงเมื่อไหร่
- Editor: พิมพ์แล้ว autocomplete ขึ้นเอง หรือ `Ctrl+Space` · `Ctrl+Enter` ยิง · `Ctrl+S` บันทึก query/variables ลงไฟล์
- Response: field ใน `masking.fields` ของ `_collection.yaml` ถูกซ่อน ติ๊ก "แสดงข้อมูล" เพื่อดูค่าจริง
- Token chip มุมขวาบน (เมื่อใช้ login): เวลาที่เหลือ, ปุ่ม **ต่ออายุ** / **ล้าง**
- **Import** — ลากไฟล์ Postman collection (v2.1) หรือ environment (.json) มาวาง

## แยก collection

| ทำอะไร | ใน UI | CLI |
| :--- | :--- | :--- |
| สร้าง collection ใหม่ | ปุ่ม **+ Collection** — เลือก "คัดลอกการตั้งค่าจาก" เพื่อใช้ auth / headers / schema เดิม | `hyperion new collection "Lab API" --from collections/main` |
| เพิ่ม request | ชี้ที่ชื่อ collection แล้วกด **+ request** | `hyperion new request collections/lab-api "Lab Results" --folder results` |
| ย้าย request ไป collection อื่น | ปุ่ม **ย้าย…** ที่หัว request | `hyperion move <file.req.yaml> collections/lab-api` |
| แยกโฟลเดอร์ออกเป็น collection | ชี้ที่ชื่อโฟลเดอร์แล้วกด **แยก** | `hyperion split collections/main/pharmacy "Pharmacy API"` |

ตอนแยกโฟลเดอร์ collection ใหม่จะคัดลอกการตั้งค่าของ collection เดิม และรวมค่าใน `_folder.yaml` ของโฟลเดอร์นั้นเข้าไป
request ที่ย้ายแล้วจะใช้ URL, auth และ headers ของ collection ปลายทาง

## Login + ต่ออายุ token อัตโนมัติ (Keycloak / OpenID)

1. ชี้ที่ชื่อ collection → **ตั้งค่า** → Auth: **Keycloak / OpenID**
2. ใส่ค่าของ env ที่เลือกอยู่: **Token URL** (เช่น `https://keycloak.example.org/realms/<realm>/protocol/openid-connect/token`), **Client ID**, **Username**, **Password**, **Client secret** (ถ้า client มี)
3. กด **ทดสอบ login** — ขึ้น "ได้ token แล้ว — ใช้ได้อีก N นาที · มี refresh token" หรือบอกสาเหตุ เช่น "Invalid user credentials"
4. env อื่น (test / prod): เปลี่ยน env ด้านบนแล้วเปิด **ตั้งค่า** อีกครั้งเพื่อใส่ค่าของ env นั้น

จากนั้นไม่ต้องทำอะไร: ก่อนยิงทุกครั้งถ้า token ใกล้หมด (30 วิ) จะขอใหม่ด้วย refresh_token, ถ้า refresh token หมดอายุด้วยจะ login ใหม่ด้วย username/password, ถ้า server ตอบ 401 จะต่ออายุแล้วยิงซ้ำ 1 ครั้ง — token chip มุมขวาบนบอกเวลาที่เหลือ
- Token URL / Client ID / Username อยู่ใน `envs/<env>.env.yaml` (`KC_*`); Password / Client secret อยู่ใน `secrets.local.yaml` (gitignored) เท่านั้น
- token ที่ได้เก็บใน `envs/<env>.local.env.yaml` (gitignored)

## Login แบบอื่น (JSON) อัตโนมัติ

Auth: **Login อื่น (JSON)** ในหน้าตั้งค่า หรือเปิดใช้ใน `_collection.yaml` (ตัวอย่างอยู่ในไฟล์เป็นคอมเมนต์): `execution.auth.type: tokenEndpoint`
ก่อนยิงทุกครั้ง ถ้า token จะหมดใน `skewSeconds` (60 วิ) → เรียก refresh endpoint → ถ้าไม่ได้ login ใหม่ → เขียน `ACCESS_TOKEN`, `REFRESH_TOKEN`, `TOKEN_EXPIRES_AT` ลง `envs/<env>.local.env.yaml` (gitignored) ทันที
ถ้า server ตอบ 401 (token ถูก revoke) จะต่ออายุแล้วยิงซ้ำ 1 ครั้ง · หลาย request พร้อมกันใช้การต่ออายุครั้งเดียวกัน

## WebSocket, Socket.IO และ gRPC

Sidebar แยก 4 ส่วนตามชนิด collection: **GraphQL**, **REST**, **gRPC**, **WebSocket** (รวม Socket.IO)
**+ Collection** → ชนิด **gRPC** (URL เริ่มต้น `{{GRPC_ADDRESS}}`) หรือ **WebSocket** (`{{WS_URL}}`) → **+ request** (WebSocket collection เลือกได้ว่า WebSocket หรือ Socket.IO)
ช่อง editor คือข้อความที่จะส่ง (ใช้ `{{ตัวแปร}}` ของ env ได้) · ช่อง Response เป็น log ข้อความสด ↑ ส่ง ↓ รับ (ซ่อนข้อมูลผู้ป่วยเหมือน response ปกติ)

| ชนิด | ใช้ยังไง |
| :--- | :--- |
| WebSocket | URL `ws://` / `wss://` → **Connect** → **Send** ส่งข้อความในช่อง → **Disconnect** · Sub-protocol ใส่ได้ (เช่น `graphql-ws`) |
| Socket.IO | URL `http(s)://` ของ server (ไม่ต้องใส่ `/socket.io`) · **Event**, **Namespace** (เช่น `/admin`), **รอ ack** · ข้อความเป็น JSON array = หลาย argument, JSON อื่น = 1 argument · ตอน connect ส่ง **Auth payload** ที่ใส่ หรือถ้าว่างส่ง `{"token": …}` จาก Bearer ของ Authorization |
| gRPC | URL = `host:port` (`grpcs://host:port` หรือติ๊ก **TLS** สำหรับ TLS) · **ไฟล์ .proto** (path จากโฟลเดอร์โปรเจกต์ หรือ path เต็ม) → เลือก **Method** → **ตัวอย่าง message** เติม JSON ให้ → **Invoke** · unary ได้คำตอบเดียวพร้อม status (`OK`, `UNAUTHENTICATED`, …); server stream แสดงทีละข้อความ, client / bidi stream กด **Send** ส่งเพิ่มได้ |

Auth และ Headers ใช้แบบเดียวกับ request อื่น: WebSocket / Socket.IO ส่งเป็น header ตอนเชื่อมต่อ, gRPC ส่งเป็น metadata (เช่น `authorization: Bearer …` จาก Keycloak login ของ collection)
request แบบนี้เปิดค้างไว้ในแอป — ใช้ใน flow / `hyperion run` ไม่ได้
ลองได้ใน `start-demo.bat`: collection **Live (WebSocket)** และ **Echo (gRPC)** ต่อกับ mock ในเครื่อง

## SOAP

**+ Collection** → ชนิด **SOAP** (URL เริ่มต้น `{{SOAP_URL}}`) หรือ **Import** → "From a WSDL (SOAP)": วาง URL หรือ path ของ WSDL แล้วเลือก collection (หรือสร้าง SOAP collection ใหม่ ตั้งชื่อตาม service ให้) — ทุก operation กลายเป็น request พร้อม envelope ตัวอย่าง (`<!-- optional -->`, `<!-- repeatable -->`, `<!-- choice -->` บอกกฎจาก WSDL) และตั้ง `SOAP_URL` ของ env ให้ถ้ายังว่าง

- ช่อง editor (แท็บ **Envelope**) คือ XML ที่ส่ง ใช้ `{{ตัวแปร}}` ของ env ได้ · แถบ SOAP: เวอร์ชัน **1.1 / 1.2**, **SOAPAction**, **WSDL** + **Load**, **Operation**, **Sample envelope** (ถามก่อนทับ envelope ที่แก้ไว้) · เลือก operation แล้วตั้ง SOAPAction กับเวอร์ชันให้ และใส่ envelope ตัวอย่างให้เอง ยกเว้น envelope ที่แก้ค่าไว้แล้ว · กด **Load** แล้วใส่ URL ของ service จาก WSDL ให้ ถ้า URL ยังว่างหรือยังเป็นที่อยู่ `…?wsdl` · URL ที่ลงท้าย `?wsdl` มีคำเตือนข้างช่อง URL
- 1.1 ส่ง `Content-Type: text/xml` + `SOAPAction` · 1.2 ส่ง `application/soap+xml; action=…` · auth และ headers ใช้แบบเดียวกับ request อื่น (header ที่ตั้งเองชนะ)
- คำตอบที่เป็น XML จัดหน้าและมีสีให้ (ทุกชนิด request) · SOAP Fault ขึ้นแถบแดงพร้อม code และข้อความ · ข้อมูลผู้ป่วยใน XML ถูกซ่อนเหมือน JSON
- Tests: `$res.xml("Tag")` อ่านค่า element แรกที่ชื่อนี้ (ไม่สน prefix), `$res.xmlAll("Tag")` ทุกตัว · ปุ่มตัวอย่าง **No SOAP Fault**, **Read a value**
- รองรับ WSDL 1.1 (document/literal และ rpc) และตาม WSDL / XSD ที่ import ต่อไปได้หลายชั้น · ไม่รองรับ: WSDL 2.0, WS-Security, ไฟล์แนบ MTOM
- env ที่ protected: CLI จะให้ใส่ `--confirm` ก่อนยิง operation ที่ชื่อดูเหมือนการเขียนข้อมูล (create, add, update, save, delete, cancel, submit, book, …)

## Flows (แบบ Postman Flows)

- sidebar ส่วน **Flows** → **+ Flow** → **+ Block** เลือก request จาก collection ไหนก็ได้ → **Run** (Ctrl+Enter)
- block รันตามลำดับ ค่าที่ `$flow.set(...)` / `pm.environment.set(...)` ส่งต่อไป block ถัดไป; แต่ละ block ขึ้น PASS/FAIL, status, เวลา, tests — กดที่ block เพื่อดู response
- **เงื่อนไข** (ไม่บังคับ) เช่น `$flow.get('visitId')` — ไม่ผ่านก็ข้าม block นั้น · **ไปต่อแม้ไม่ผ่าน** — ไม่หยุด flow เมื่อ block นี้ fail
- env ที่ protected (prod): ในแอปรัน mutation ได้เลย; `hyperion flow run` บน CLI จะหยุดที่ mutation
- เก็บเป็น `flows/<ชื่อ>.flow.yaml` และรันบน CI ได้: `hyperion flow run flows/x.flow.yaml --env test --reporter junit`

## Export / import

- **ทั้งโปรเจกต์:** เมนูชื่อโปรเจกต์ → **Export โปรเจกต์** บันทึก `<ชื่อโปรเจกต์>.hyperion.json` มี `hyperion.yaml`, ไฟล์ env, ทุก collection, request และ flow · **นำเข้าโปรเจกต์…** สร้างเป็นโฟลเดอร์ใหม่ (ใส่ที่ตั้งให้ในโฟลเดอร์โปรเจกต์) แล้วเปิดให้ · ไม่รวม secret (`secrets.local.yaml`) และ token ที่เก็บไว้ (`envs/*.local.env.yaml`) — ใส่ใหม่ในเครื่องปลายทาง

- ปุ่ม **Export** ที่ collection (ชี้ที่ชื่อ collection) หรือที่ flow บันทึกเป็นไฟล์เดียว `<ชื่อ>.hyperion.json` (ลงโฟลเดอร์ Downloads): ทุก request ใน collection หรือ flow พร้อมทุก request ที่ใช้ รวมตั้งค่าของ collection / โฟลเดอร์ · ไม่รวม secret (เก็บไว้เป็น `{{secret:…}}`)
- ปุ่ม **Import** ในส่วน Flows (หรือลากไฟล์ใส่หน้าต่าง Import) นำเข้าโปรเจกต์ที่เปิดอยู่: collection ที่ยังไม่มีจะถูกสร้าง, request ที่เหมือนเดิมข้ามไป, request ที่ต่างจากของเดิมบันทึกแยกเป็น `…-imported` และ flow ชี้ไปที่ตัวใหม่ · ตั้งค่า collection เดิมของคุณไม่ถูกทับ
- **อ่านจาก Postman desktop** ได้ทั้ง GraphQL และ REST — REST ไปอยู่ใน collection แบบ REST ชื่อเดียวกัน (หรือ "<ชื่อ> (REST)") พร้อม method, URL, headers, auth, body และ script · รหัสผ่าน / secret / token / API key ที่พิมพ์ไว้ย้ายไป `secrets.local.yaml` · import ซ้ำจะอัปเดตของเดิม (จับคู่ด้วย id ของ Postman ทั้งโปรเจกต์ แม้ collection ถูกเปลี่ยนชื่อ)

## Import จาก Postman

- **request แบบ GraphQL ของ Postman export ไม่ได้** (ข้อจำกัดของ Postman) → **Import** → "วาง cURL / GraphQL query": คัดลอก Code (`</>`) → cURL จาก Postman (หรือ Copy as cURL จากเบราว์เซอร์) หรือคัดลอกแค่ query จากแท็บ Query แล้ววาง เลือก collection ที่จะใส่
  - Bearer token ใน cURL ไม่ถูกเขียนลงไฟล์ request: เก็บใน `envs/<env>.local.env.yaml` (gitignored) เป็น `BEARER_TOKEN` แล้ว request ใช้ `{{BEARER_TOKEN}}`
  - ถ้า collection ใช้ `{{GQL_URL}}` และ env ยังไม่ได้ตั้ง จะตั้ง `GQL_URL` ให้จาก URL ใน cURL

- Collection: request GraphQL (ทั้ง body แบบ GraphQL และ raw JSON ที่มี `query`) → `GraphQLRequest`, ที่เหลือ → `HttpRequest`; โฟลเดอร์ → โฟลเดอร์; auth bearer/basic/apikey; script `pm.*` ใช้ต่อได้ (มี shim: `pm.test`, `pm.expect` แบบ chai, `pm.response`, `pm.environment`, `pm.sendRequest`)
- Environment: ตัวแปรชนิด secret หรือชื่อแบบ password/token/secret/apikey ถูกย้ายไป `secrets.local.yaml` แล้วอ้างเป็น `{{secret:NAME}}`; env ที่ชื่อมี "prod" ถูกตั้งเป็น protected
- ไม่รองรับ: script ระดับ collection/folder, body form-data, OAuth2 flow (แปลงเป็น bearer `{{ACCESS_TOKEN}}`)

## CLI (ใช้ใน GitLab CI ได้)

```bash
node bin/hyperion.mjs run path/to/project/collections --env test --reporter junit --out report.xml
```

```text
hyperion init [dir]                                     โปรเจกต์ใหม่ (dev / test / prod / training)
hyperion run <file|dir>... [--env dev] [--var K=V] [--data rows.csv] [--confirm OpName] [-v] [--unmask]
hyperion schema sync <collectionDir> [--env] [--snapshot] [--reprobe]
hyperion schema export --url <graphql-url> [-H "K: V"] --out schema.graphql
hyperion token <status|refresh|clear> <collectionDir> [--env]
hyperion import <postman.json>... [--project dir]
hyperion new collection|request …   hyperion move …   hyperion split …
hyperion flow run <flows/x.flow.yaml> [--env test] [--reporter junit --out f]
hyperion serve [dir] [--port 4321] [--open]             ไม่ใส่ dir = โปรเจกต์ล่าสุด
hyperion demo [--open]
```

บน CI (`CI` env var ถูกตั้ง) token ไม่ถูกเขียนลงไฟล์; secret ส่งผ่าน `HYPERION_SECRET_<NAME>`

## โครงสร้างโปรเจกต์

```
hyperion.yaml                      ชื่อโปรเจกต์, defaultEnv, schemaEnv (ไม่บังคับ)
envs/<env>.env.yaml                ตัวแปรต่อ env (commit ได้ ห้ามมีความลับ)
envs/<env>.local.env.yaml          token ที่ระบบเขียนให้ (gitignored)
secrets.local.yaml                 รหัสผ่าน/คีย์ (gitignored)
collections/<name>/_collection.yaml  execution (URL/auth/headers), schemaDiscovery, masking
collections/<name>/**/_folder.yaml   override auth/headers/variables ระดับโฟลเดอร์
collections/<name>/**/*.req.yaml     query + variables + scripts
.hyperion/                         schema cache, state (gitignored)
```

ลำดับตัวแปร (ต่ำ → สูง): `hyperion.yaml` < collection/folder/request < env < env.local < data row < flow < runtime

## ทดสอบ

```bash
npm test
```

26 tests: schema fallback (รวมยืม schema จาก dev), auth ระดับ request และแยกตาม env, schema explorer, flows, วาง cURL, ต่ออายุ token / 401 retry / single-flight, Keycloak, schema drift, prod guard, Postman import, pm shim, สร้าง/ย้าย/แยก collection, WebSocket / Socket.IO / gRPC, host เป็นตัวแปร env, Scripts ในแอป
