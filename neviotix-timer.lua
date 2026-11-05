-- NEVIOTIX Timer: local service start and optional OBS hotkeys.
-- Uses LuaJIT FFI to launch wscript without a console or shell window.
-- OBS scripting API: https://docs.obsproject.com/scripting
obs = obslua

local hotkeys = {}
local script_directory = script_path():gsub("/", "\\")
local ffi_ready, ffi = pcall(require, "ffi")
local kernel32 = nil
local shell32 = nil
local warned = false
local allowed = {start = true, toggle = true, reset = true, plus60 = true, minus60 = true}

if ffi_ready and package.config:sub(1, 1) == "\\" then
    local declaration_ok = pcall(function()
        ffi.cdef[[
            int MultiByteToWideChar(unsigned int code_page, unsigned long flags,
                const char *text, int length, unsigned short *output, int capacity);
            void *ShellExecuteW(void *window, const unsigned short *operation,
                const unsigned short *file, const unsigned short *parameters,
                const unsigned short *directory, int show_command);
        ]]
        kernel32 = ffi.load("kernel32")
        shell32 = ffi.load("shell32")
    end)
    ffi_ready = declaration_ok
else
    ffi_ready = false
end

local function wide(text)
    local length = kernel32.MultiByteToWideChar(65001, 0, text, #text, nil, 0)
    if length <= 0 then error("Windows-Pfad konnte nicht gelesen werden") end
    local value = ffi.new("unsigned short[?]", length + 1)
    if kernel32.MultiByteToWideChar(65001, 0, text, #text, value, length) ~= length then
        error("Windows-Pfad konnte nicht umgewandelt werden")
    end
    return value
end

local function start_hidden(action)
    if not allowed[action] then return end
    if not ffi_ready then
        if not warned then
            obs.script_log(obs.LOG_WARNING,
                "NEVIOTIX Timer: Verdeckter Windows-Start nicht verfügbar. Bitte start.vbs im Timer-Ordner öffnen.")
            warned = true
        end
        return
    end
    local ok, failure = pcall(function()
        local wscript = (os.getenv("WINDIR") or "C:\\Windows") .. "\\System32\\wscript.exe"
        local launcher = script_directory .. "start.vbs"
        local parameters = '//B //Nologo "' .. launcher .. '" ' .. action
        local result = shell32.ShellExecuteW(nil, wide("open"), wide(wscript),
            wide(parameters), wide(script_directory), 0)
        if tonumber(ffi.cast("intptr_t", result)) <= 32 then
            error("Windows konnte den Timer-Starter nicht öffnen")
        end
    end)
    if not ok then obs.script_log(obs.LOG_WARNING, "NEVIOTIX Timer: " .. tostring(failure)) end
end

local function register_hotkey(settings, name, label, action)
    local callback = function(pressed)
        if pressed then start_hidden(action) end
    end
    local id = obs.obs_hotkey_register_frontend(name, label, callback)
    local saved = obs.obs_data_get_array(settings, name)
    if saved ~= nil then
        obs.obs_hotkey_load(id, saved)
        obs.obs_data_array_release(saved)
    end
    table.insert(hotkeys, {id = id, name = name, callback = callback})
end

function script_description()
    return [[<b>NEVIOTIX TIMER</b><br><br>
Dein eigener lokaler Countdown für OBS. Startet den Timer-Dienst mit OBS.<br>
Das Dock findest du unter <b>http://127.0.0.1:18771/</b>.<br><br>
Optionale globale Tasten: OBS → Einstellungen → Hotkeys → <b>NEVIOTIX Timer</b>.<br>
Start/Pause, Zurücksetzen und ±1 Minute stehen zur Verfügung.]]
end

function script_load(settings)
    register_hotkey(settings, "NEVIOTIX_Timer_Toggle", "NEVIOTIX Timer: Start / Pause", "toggle")
    register_hotkey(settings, "NEVIOTIX_Timer_Reset", "NEVIOTIX Timer: Zurücksetzen", "reset")
    register_hotkey(settings, "NEVIOTIX_Timer_Plus60", "NEVIOTIX Timer: +1 Minute", "plus60")
    register_hotkey(settings, "NEVIOTIX_Timer_Minus60", "NEVIOTIX Timer: −1 Minute", "minus60")
    start_hidden("start")
end

function script_save(settings)
    for _, hotkey in ipairs(hotkeys) do
        local saved = obs.obs_hotkey_save(hotkey.id)
        obs.obs_data_set_array(settings, hotkey.name, saved)
        obs.obs_data_array_release(saved)
    end
end

function script_unload()
    for _, hotkey in ipairs(hotkeys) do
        obs.obs_hotkey_unregister(hotkey.callback)
    end
    hotkeys = {}
end

function script_properties()
    local properties = obs.obs_properties_create()
    obs.obs_properties_add_button(properties, "start_service", "Timer-Dienst starten", function()
        start_hidden("start")
        return false
    end)
    return properties
end
