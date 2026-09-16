# JS 桥接类必须原样保留。
# Bridge 的方法是被 WebView 按「字符串名」调用的（AndroidBridge.saveText 等），
# 混淆后方法名会变，WebView 找不到方法只会静默失败——不抛异常、不回调，
# 表现就是「点了按钮没反应」，正是本项目历史上踩过的坑。
# 当前 minifyEnabled false 不触发混淆，此规则为将来开启时兜底。
-keepclassmembers class com.debugmh.bookcard.MainActivity$Bridge {
    public *;
}
