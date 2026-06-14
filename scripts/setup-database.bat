@echo off
setlocal

cd /d "%~dp0\..\.."

set "NODE_DIR=C:\Program Files\nodejs"
if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"

set "QUICK=%~1"
if "%QUICK%"=="" set "QUICK=quick"

echo [INFO] Checking PostgreSQL connection (localhost:5432)...

node backend\scripts\setup-database.mjs
if errorlevel 1 exit /b 1

if /i "%QUICK%"=="quick" (
    if exist "node_modules\.prisma\client\query_engine-windows.dll.node" (
        echo [OK] Prisma client exists, skipping generate.
        goto :push
    )
)

echo [INFO] Generating Prisma client...
call npm run db:generate --workspace=backend
if errorlevel 1 (
    if exist "node_modules\.prisma\client\query_engine-windows.dll.node" (
        echo [WARN] Generate skipped - client already in use. Continuing...
    ) else (
        echo [ERROR] db:generate failed.
        exit /b 1
    )
)

:push
echo [INFO] Applying database schema...
if /i "%QUICK%"=="quick" (
    call npm run db:push:quick --workspace=backend
) else (
    call npm run db:push --workspace=backend
)
if errorlevel 1 (
    echo [ERROR] db:push failed. Check backend\.env DATABASE_URL
    exit /b 1
)

if /i "%QUICK%"=="full" (
    echo [INFO] Seeding initial data...
    call npm run db:seed --workspace=backend
    if errorlevel 1 echo [WARN] Seed skipped.
)

echo.
echo [OK] Database ready.
exit /b 0
