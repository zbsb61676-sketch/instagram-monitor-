@echo off
set msg=%*
if "%msg%"=="" set msg=Update application

echo ====================================================
echo 🚀 Pushing changes to GitHub for Auto-Redeployment...
echo ====================================================

git add .
git commit -m "%msg%"
git push origin main

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ✅ Changes pushed successfully!
    echo 🌐 Cloud hosting (Render / Railway) is now automatically building and deploying your changes.
) else (
    echo.
    echo ⚠️ Push failed. Please check your GitHub remote or internet connection.
)
