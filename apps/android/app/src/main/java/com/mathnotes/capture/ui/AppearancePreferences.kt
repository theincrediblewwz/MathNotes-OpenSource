package com.mathnotes.capture.ui

import android.content.Context

enum class MathNotesThemeId(val storageValue: String, val label: String) {
    DEFAULT_LIGHT("default_light", "默认明亮"),
    READING("reading", "低干扰阅读"),
    HIGH_CONTRAST("high_contrast", "高对比"),
    DARK("dark", "深色");

    companion object {
        fun fromStorage(value: String?): MathNotesThemeId = entries.firstOrNull { it.storageValue == value } ?: DEFAULT_LIGHT
    }
}

enum class MathNotesLocaleId(val storageValue: String) {
    ZH_CN("zh-CN"),
    EN_US("en-US")
}

class AppearancePreferences(context: Context) {
    private val preferences = context.getSharedPreferences("appearance", Context.MODE_PRIVATE)

    fun loadTheme(): MathNotesThemeId = MathNotesThemeId.fromStorage(preferences.getString("theme_id", null))

    fun saveTheme(themeId: MathNotesThemeId): Boolean = preferences.edit().putString("theme_id", themeId.storageValue).commit()
}
