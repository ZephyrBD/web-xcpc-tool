# AGENTS.md

Java 21 Spring Boot 4 backend that serves two frontends from `src/main/resources/static` and integrates with a DOMjudge instance (auth, balloon tickets, code printing, leaderboard board). GPL-2.0 header required in Gradle files.

## Multi-project layout

- **Root (Gradle)** — Spring Boot app `top.techmczs.cuitxcpctool`, entrypoint `CuitXcpcToolApplication.java`. MyBatis-Plus + encrypted H2 file DB (`cuit_xcpc.mv.db`), no Flyway — schema is `src/main/resources/script.sql`, re-run on every startup (`spring.sql.init.mode=always`).
- **`vue/`** — Vue 3 + Element Plus management UI (npm/vue-cli). Build output goes to `../src/main/resources/static` (see `vue/vue.config.js`), public path `/cxtool/`. Dev server on port 8081 proxying `/cxtool` to the backend on 8080.
- **`xcpcio/`** — vendored fork of the XCPCIO leaderboard (pnpm monorepo). Board app build output goes to `src/main/resources/static/board` (see `xcpcio/packages/apps/board/vite.config.ts`).
- **`proxy/`** — standalone Node reverse proxy for DOMjudge auto-login; independent of the build.
- **`script/`** — ops artifacts, not build code: nginx configs, `print.sh`, Python generators for DOMjudge team/org JSON, H2 `script.sql` source.

## Commands

Full CI build (matches `.github/workflows/build-jar.yml` order — frontends must build before Gradle, and Gradle is run with `-x test`):

```bash
cd vue && npm install && npm run build
cd xcpcio && pnpm install && pnpm run build
./gradlew clean build
```

- Run backend: `./gradlew bootRun` (or `java -jar build/libs/*.jar`)
- Backend tests only: `./gradlew test` (JUnit platform)
- Board tests: `pnpm -C xcpcio test` (vitest in libs/core); board e2e: cypress in `xcpcio/packages/apps/board`
- `./gradlew clean` also deletes `./pdf` (task `cleanPDF`); `cleanFronted` deletes the built static frontends

Gotchas:
- `vue/package-lock.json` is gitignored while CI uses `npm install` — don't rely on a lockfile there; `xcpcio` uses pnpm (`pnpm-workspace.yaml`).
- `src/main/resources/static/**` is gitignored build output — never commit it, and `git status` won't show frontend changes there.

## Configuration & runtime quirks

- Config comes from `application.properties` plus optional local `./db-secret.properties` and `./settings.properties` (generated on first launch; samples in `src/main/resources/*.properties.sample`). Both files are gitignored; `db-secret.properties` is a real secret file present in the working tree.
- H2 password is the concatenation of two properties (`db.file.password` + `db.user.password`) — both parts are needed.
- The backend context path is `/cxtool` — all API routes live under it.
- `settings.properties` toggles major behavior (special OMSClient auth via cookie, `DjAuthService`; nginx token-verify flow; online-print ban; unfreeze time). The nginx flow design is documented in README.md.

## Where things live (backend)

Standard layered Spring layout under `top.techmczs.cuitxcpctool`: `controller` (Board, DjAuth, DjBalloon, DjPrint, DjTeam, Universal), `services`/`services.impl`, `mapper`, `entity` (incl. `entity.domjudge`), `dto`, `properties` (config binding), `interceptor`, `config`. Board data conversion from DOMjudge → XCPCIO format is in `BoardConvertService(Impl)`.
