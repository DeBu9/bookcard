#!/usr/bin/env bash
# 一键重建 APK —— 读书卡
#
# 用法：
#   bash build-apk.sh              # 出正式签名包（默认，需先配好 keystore.properties）
#   bash build-apk.sh release      # 同上
#   bash build-apk.sh debug        # 出调试包（不需要签名配置）
#
# 依赖：JDK 17 + Android SDK（platforms;android-34、build-tools;34.0.0）。
# 工具链按下述顺序自动查找，找到第一个就用：
#   1. 环境变量 JAVA_HOME / ANDROID_HOME
#   2. 常见安装位置（Android Studio 自带 JBR、各平台 SDK 默认路径）
#   3. 用户目录下的隔离工具链 ~/.workbuddy/binaries（多数机器上没有，自动跳过）
#
# 只改 index.html 就好，脚本会自动同步进 assets 再编译。

set -euo pipefail

MODE="${1:-release}"
case "$MODE" in
  release|debug) ;;
  *) echo "用法：bash build-apk.sh [release|debug]（默认 release）" >&2; exit 1 ;;
esac

PROJ="$(cd "$(dirname "$0")" && pwd)"
ANDROID_DIR="$PROJ/android"
# 可选：用环境变量 OVERRIDE_TOOLCHAIN 指向自己的工具链目录，不设则按上面的顺序自动找
ISOLATED="${OVERRIDE_TOOLCHAIN:-$HOME/.workbuddy/binaries}"

# ---------------- 定位 JDK 17 ----------------
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "${JAVA_HOME}/bin/javac" ]; then
  for c in \
    "$ISOLATED"/jdk/jdk-17* \
    "$HOME"/.jdks/*17* \
    "/c/Program Files/Android/Android Studio/jbr" \
    "/c/Program Files/Java/jdk-17"* \
    "/c/Program Files/Eclipse Adoptium/jdk-17"* \
    /usr/lib/jvm/java-17-openjdk* \
    /usr/lib/jvm/temurin-17-jdk* \
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
    /opt/homebrew/opt/openjdk@17
  do
    if [ -x "$c/bin/javac" ]; then export JAVA_HOME="$c"; break; fi
  done
fi
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "${JAVA_HOME}/bin/javac" ]; then
  echo "找不到 JDK 17。请安装 JDK 17 后设置 JAVA_HOME，例如：" >&2
  echo "  export JAVA_HOME=/path/to/jdk-17" >&2
  exit 1
fi

# ---------------- 定位 Android SDK ----------------
if [ -z "${ANDROID_HOME:-}" ] || [ ! -d "${ANDROID_HOME}/platforms" ]; then
  for c in \
    "$ISOLATED/android-sdk" \
    "$HOME/Android/Sdk" \
    "$HOME/Library/Android/sdk" \
    "$HOME/AppData/Local/Android/Sdk"
  do
    if [ -d "$c/platforms" ]; then export ANDROID_HOME="$c"; break; fi
  done
fi
if [ -z "${ANDROID_HOME:-}" ] || [ ! -d "${ANDROID_HOME}/platforms" ]; then
  echo "找不到 Android SDK（需含 platforms/ 目录）。请安装后设置 ANDROID_HOME，例如：" >&2
  echo "  sdkmanager \"platforms;android-34\" \"build-tools;34.0.0\"" >&2
  echo "  export ANDROID_HOME=\$HOME/Android/Sdk" >&2
  exit 1
fi

# Gradle 需要 local.properties 指明 SDK 位置；该文件不进仓库，缺失时自动生成
if [ ! -f "$ANDROID_DIR/local.properties" ]; then
  if command -v cygpath >/dev/null 2>&1; then
    SDK_DIR="$(cygpath -w "$ANDROID_HOME" | sed 's#\\#/#g')"   # Windows 下 AGP 认正斜杠
  else
    SDK_DIR="$ANDROID_HOME"
  fi
  echo "sdk.dir=$SDK_DIR" > "$ANDROID_DIR/local.properties"
  echo "==> 已生成 android/local.properties（sdk.dir=$SDK_DIR）"
fi

# ---------------- 定位 Gradle ----------------
# 顺序：本机已有的 Gradle（秒启动）→ PATH 里的 gradle → 工程自带的 wrapper。
# wrapper 放在最后是因为它首次运行要从 services.gradle.org 下载约 100MB 的发行包，
# 网络不畅时会卡很久甚至失败；而 CI（.github/workflows/ci.yml）是直接调 ./gradlew 的，
# 不受这里影响。
cd "$ANDROID_DIR"
if [ -x "$ISOLATED/gradle/gradle-8.2/bin/gradle" ]; then
  GRADLE=("$ISOLATED/gradle/gradle-8.2/bin/gradle")
elif command -v gradle >/dev/null 2>&1; then
  GRADLE=(gradle)
elif [ -x "./gradlew" ]; then
  GRADLE=(./gradlew)
else
  echo "找不到 Gradle。请安装 Gradle 8.x，或在 android/ 下执行 gradle wrapper 生成 wrapper。" >&2
  exit 1
fi

# 隔离依赖缓存，避免污染 ~/.gradle（仅当隔离目录存在时）
[ -d "$ISOLATED/gradle/home" ] && export GRADLE_USER_HOME="$ISOLATED/gradle/home"
export GRADLE_OPTS="-Dorg.gradle.daemon=false -Dfile.encoding=UTF-8"

echo "==> 工具链"
echo "    JAVA_HOME    $JAVA_HOME"
echo "    ANDROID_HOME $ANDROID_HOME"
echo "    Gradle       ${GRADLE[0]}"

# release 必须有 keystore：没有的话 Gradle 只产出未签名包，装的时候报「解析包时出现问题」，
# 属于闷声出错，所以这里直接拦住。
if [ "$MODE" = "release" ] && [ ! -f "$ANDROID_DIR/keystore.properties" ]; then
  echo >&2
  echo "缺少 android/keystore.properties，无法出正式签名包。" >&2
  echo "  · 只想本地跑：改用  bash build-apk.sh debug" >&2
  echo "  · 要出正式包：cp android/keystore.properties.example android/keystore.properties 后填入签名信息" >&2
  exit 1
fi

# 关键：网页改了必须同步进 assets，否则打出来的还是旧页面
echo "==> 同步 index.html -> assets"
cp "$PROJ/index.html" "$ANDROID_DIR/app/src/main/assets/index.html"
md5sum "$PROJ/index.html" "$ANDROID_DIR/app/src/main/assets/index.html"

echo "==> 开始编译（$MODE）"
if [ "$MODE" = "release" ]; then
  "${GRADLE[@]}" assembleRelease --no-daemon
  OUT="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
else
  "${GRADLE[@]}" assembleDebug --no-daemon
  OUT="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
fi
[ -f "$OUT" ] || { echo "编译产物不存在：$OUT" >&2; exit 1; }

VERSION="$(grep -oE "versionName[[:space:]]+\"[^\"]+\"" "$ANDROID_DIR/app/build.gradle" | head -1 | grep -oE "[0-9][^\"]*")"
if [ "$MODE" = "release" ]; then
  DEST="$PROJ/读书卡-v${VERSION}.apk"
else
  DEST="$PROJ/读书卡-v${VERSION}-debug.apk"
fi
cp "$OUT" "$DEST"

echo
echo "==> 完成（$MODE）"
ls -lh "$DEST"
echo "MD5    $(md5sum "$DEST" | cut -d' ' -f1)"
echo "SHA256 $(sha256sum "$DEST" | cut -d' ' -f1)"
