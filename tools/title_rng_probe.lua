-- title_rng_probe.lua
--
-- NTSC 1.02 probe for the RNG work performed by gmTitle_801A165C.
-- It records three independently useful intervals:
--   1. the calendar-second loop,
--   2. gm_801BF128's random-history setup, and
--   3. their combined RNG consumption.
--
-- The hooks are guarded by exact original-opcode checks and are restored when
-- the script is cancelled. Results are appended to title_rng_probe.csv in the
-- Dolphin Scripts directory.

local RNG_ADDR       = 0x804D5F90
local SECONDS_HOOK   = 0x801A17D8
local HISTORY_HOOK   = 0x801A17F0
local SECONDS_CAVE   = 0x804E6E00
local HISTORY_CAVE   = 0x804E6E40
local CHAR_POOL_HOOK = 0x801BF1F8
local STAGE_POOL_HOOK = 0x801BF38C
local CHAR_POOL_CAVE = 0x804E6EA0
local STAGE_POOL_CAVE = 0x804E6F40
local BOOT_SEED_HOOK = 0x8015FFA8
local BOOT_SEED_CAVE = 0x804E6FC0
local CHAR_POOL_DATA = 0x804E7200
local STAGE_POOL_DATA = 0x804E7220
local CURRENT_STAGE_DATA = 0x804E7240
local BOOT_SEED_DATA = 0x804E7244
local BOOT_READY_DATA = 0x804E7248
local DATA_BASE      = 0x804E6D80

local ORIGINAL_SECONDS = 0x8BA1000E -- lbz r29, 0xe(r1)
local ORIGINAL_HISTORY = 0x4801D939 -- bl gm_801BF128
local PATCH_SECONDS    = 0x48345628 -- b SECONDS_CAVE
local PATCH_HISTORY    = 0x48345651 -- bl HISTORY_CAVE
local ORIGINAL_CHAR_POOL = 0x481C1389 -- bl HSD_Randi
local ORIGINAL_STAGE_POOL = 0x481C11F5 -- bl HSD_Randi
local PATCH_CHAR_POOL = 0x48327CA9 -- bl CHAR_POOL_CAVE
local PATCH_STAGE_POOL = 0x48327BB5 -- bl STAGE_POOL_CAVE
local ORIGINAL_BOOT_SEED = 0x4BEC83E5 -- bl lbAudioAx_8002838C
local PATCH_BOOT_SEED = 0x48387019 -- bl BOOT_SEED_CAVE

local START_SEED       = DATA_BASE + 0x00
local CALENDAR_SECOND  = DATA_BASE + 0x04
local AFTER_SECONDS    = DATA_BASE + 0x08
local AFTER_HISTORY    = DATA_BASE + 0x0C
local READY_FLAG       = DATA_BASE + 0x10
local TARGETS_LEFT_ADDR = 0x8049ED9D

local installed = false
local status = "title RNG probe: starting"
local last_title_seed = nil
local last_targets_left = nil
local btt_captured = false
local boot_captured = false

local seconds_code = {
    0x8BA1000E, -- lbz r29, 0xe(r1) (displaced original instruction)
    0x3D60804D, -- lis r11, 0x804d
    0x818B5F90, -- lwz r12, 0x5f90(r11) (RNG seed)
    0x3D60804E, -- lis r11, 0x804e
    0x918B6D80, -- stw r12, START_SEED(r11)
    0x93AB6D84, -- stw r29, CALENDAR_SECOND(r11)
    0x4BCBA9C4, -- b 0x801a17dc
}

local history_code = {
    0x7C0802A6, -- mflr r0
    0x9421FFF0, -- stwu r1, -0x10(r1)
    0x90010014, -- stw r0, 0x14(r1)
    0x3D60804D, -- lis r11, 0x804d
    0x818B5F90, -- lwz r12, 0x5f90(r11)
    0x3D60804E, -- lis r11, 0x804e
    0x918B6D88, -- stw r12, AFTER_SECONDS(r11)
    0x4BCD82CD, -- bl gm_801BF128
    0x3D60804D, -- lis r11, 0x804d
    0x818B5F90, -- lwz r12, 0x5f90(r11)
    0x3D60804E, -- lis r11, 0x804e
    0x918B6D8C, -- stw r12, AFTER_HISTORY(r11)
    0x39800001, -- li r12, 1
    0x918B6D90, -- stw r12, READY_FLAG(r11)
    0x80010014, -- lwz r0, 0x14(r1)
    0x38210010, -- addi r1, r1, 0x10
    0x7C0803A6, -- mtlr r0
    0x4E800020, -- blr
}

local char_pool_code = {
    0x7C0802A6, 0x9421FFF0, 0x90010014, 0x3D60804E,
    0x819E0000, 0x918B7200, 0x819E0004, 0x918B7204,
    0x819E0008, 0x918B7208, 0x819E000C, 0x918B720C,
    0x819E0010, 0x918B7210, 0x819E0014, 0x918B7214,
    0x819E0018, 0x918B7218, 0x819E001C, 0x918B721C,
    0x3D40804A, 0xA18AE554, 0x918B7240, 0x4BE99685,
    0x80010014, 0x38210010, 0x7C0803A6, 0x4E800020,
}

local stage_pool_code = {
    0x7C0802A6, 0x9421FFF0, 0x90010014, 0x3D60804E,
    0x819E0000, 0x918B7220, 0x819E0004, 0x918B7224,
    0x819E0008, 0x918B7228, 0x819E000C, 0x918B722C,
    0x819E0010, 0x918B7230, 0x819E0014, 0x918B7234,
    0x819E0018, 0x918B7238, 0x819E001C, 0x918B723C,
    0x4BE995F1, 0x80010014, 0x38210010, 0x7C0803A6,
    0x4E800020,
}

local boot_seed_code = {
    0x7C0802A6, 0x9421FFF0, 0x90010014, 0x3D60804D,
    0x818B5F90, 0x3D60804E, 0x918B7244, 0x39800001,
    0x918B7248, 0x4BB413A9, 0x80010014, 0x38210010,
    0x7C0803A6, 0x4E800020,
}

local function write_code(address, words)
    for i, word in ipairs(words) do
        WriteValue32(address + (i - 1) * 4, word)
    end
end

local function rng_advance(seed)
    return (seed * 214013 + 2531011) % 2^32
end

local function small_distance(start_seed, target_seed, limit)
    local seed = start_seed
    for count = 0, limit do
        if seed == target_seed then return count end
        seed = rng_advance(seed)
    end
    return -1
end

local function clear_capture()
    for offset = 0, 0x10, 4 do
        WriteValue32(DATA_BASE + offset, 0)
    end
    for offset = 0, 0x40, 4 do
        WriteValue32(CHAR_POOL_DATA + offset, 0)
    end
    WriteValue32(BOOT_SEED_DATA, 0)
    WriteValue32(BOOT_READY_DATA, 0)
end

local function csv_path()
    return GetScriptsDir() .. "/title_rng_probe_v2.csv"
end

local function btt_csv_path()
    return GetScriptsDir() .. "/btt_startup_probe.csv"
end

local function boot_csv_path()
    return GetScriptsDir() .. "/boot_seed_probe.csv"
end

local function read_pool(address)
    local values = {}
    for i = 0, 7 do values[#values + 1] = ReadValue32(address + i * 4) end
    return values
end

local function join_pool(values)
    local parts = {}
    for _, value in ipairs(values) do parts[#parts + 1] = string.format("%X", value) end
    return table.concat(parts, " ")
end

local function append_capture(start_seed, second, after_seconds, after_history,
                              seconds_calls, history_calls, total_calls,
                              character_pool, stage_pool, current_stage)
    local path = csv_path()
    local exists = io.open(path, "r")
    if exists then exists:close() end

    local file = assert(io.open(path, "a"), "could not open " .. path)
    if not exists then
        file:write("host_time,start_seed,calendar_second,after_seconds,after_history," ..
                   "seconds_calls,history_calls,total_calls,character_pool," ..
                   "stage_pool,current_stage_id\n")
    end
    file:write(string.format("%s,%08X,%d,%08X,%08X,%d,%d,%d,%s,%s,%d\n",
        os.date("%Y-%m-%dT%H:%M:%S"), start_seed, second, after_seconds,
        after_history, seconds_calls, history_calls, total_calls,
        join_pool(character_pool), join_pool(stage_pool), current_stage))
    file:close()
end

local function append_btt_capture(title_seed, stage_loaded_seed)
    local path = btt_csv_path()
    local exists = io.open(path, "r")
    if exists then exists:close() end
    local file = assert(io.open(path, "a"), "could not open " .. path)
    if not exists then
        file:write("host_time,title_after_history,stage_loaded_seed\n")
    end
    file:write(string.format("%s,%08X,%08X\n", os.date("%Y-%m-%dT%H:%M:%S"),
                             title_seed, stage_loaded_seed))
    file:close()
end

local function append_boot_capture(seed)
    local path = boot_csv_path()
    local exists = io.open(path, "r")
    if exists then exists:close() end
    local file = assert(io.open(path, "a"), "could not open " .. path)
    if not exists then file:write("host_time,boot_seed\n") end
    file:write(string.format("%s,%08X\n", os.date("%Y-%m-%dT%H:%M:%S"), seed))
    file:close()
end

function onScriptStart()
    local actual_seconds = ReadValue32(SECONDS_HOOK)
    local actual_history = ReadValue32(HISTORY_HOOK)
    local actual_char_pool = ReadValue32(CHAR_POOL_HOOK)
    local actual_stage_pool = ReadValue32(STAGE_POOL_HOOK)
    local actual_boot_seed = ReadValue32(BOOT_SEED_HOOK)
    if actual_seconds ~= ORIGINAL_SECONDS or actual_history ~= ORIGINAL_HISTORY or
       actual_char_pool ~= ORIGINAL_CHAR_POOL or actual_stage_pool ~= ORIGINAL_STAGE_POOL or
       actual_boot_seed ~= ORIGINAL_BOOT_SEED then
        status = string.format(
            "title RNG probe: REFUSED\nopcodes do not match NTSC 1.02\n" ..
            "%08X:%08X %08X:%08X\n%08X:%08X %08X:%08X",
            SECONDS_HOOK, actual_seconds, HISTORY_HOOK, actual_history,
            CHAR_POOL_HOOK, actual_char_pool, STAGE_POOL_HOOK, actual_stage_pool)
        SetScreenText(status)
        return
    end

    clear_capture()
    write_code(SECONDS_CAVE, seconds_code)
    write_code(HISTORY_CAVE, history_code)
    write_code(CHAR_POOL_CAVE, char_pool_code)
    write_code(STAGE_POOL_CAVE, stage_pool_code)
    write_code(BOOT_SEED_CAVE, boot_seed_code)
    WriteValue32(SECONDS_HOOK, PATCH_SECONDS)
    WriteValue32(HISTORY_HOOK, PATCH_HISTORY)
    WriteValue32(CHAR_POOL_HOOK, PATCH_CHAR_POOL)
    WriteValue32(STAGE_POOL_HOOK, PATCH_STAGE_POOL)
    WriteValue32(BOOT_SEED_HOOK, PATCH_BOOT_SEED)
    installed = true
    last_title_seed = nil
    last_targets_left = nil
    btt_captured = false
    boot_captured = false
    status = "title RNG probe: ARMED\nstart or restart Melee normally"
    SetScreenText(status)
end

function onStateLoaded()
    clear_capture()
end

function onStateSaved()
end

function onScriptCancel()
    if installed then
        WriteValue32(SECONDS_HOOK, ORIGINAL_SECONDS)
        WriteValue32(HISTORY_HOOK, ORIGINAL_HISTORY)
        WriteValue32(CHAR_POOL_HOOK, ORIGINAL_CHAR_POOL)
        WriteValue32(STAGE_POOL_HOOK, ORIGINAL_STAGE_POOL)
        WriteValue32(BOOT_SEED_HOOK, ORIGINAL_BOOT_SEED)
    end
end

function onScriptUpdate()
    if not installed then
        SetScreenText(status)
        return
    end


    if not boot_captured and ReadValue32(BOOT_READY_DATA) ~= 0 then
        append_boot_capture(ReadValue32(BOOT_SEED_DATA))
        boot_captured = true
    end

    if ReadValue32(READY_FLAG) ~= 0 then
        local start_seed = ReadValue32(START_SEED)
        local second = ReadValue32(CALENDAR_SECOND)
        local after_seconds = ReadValue32(AFTER_SECONDS)
        local after_history = ReadValue32(AFTER_HISTORY)
        local seconds_calls = small_distance(start_seed, after_seconds, 64)
        local history_calls = small_distance(after_seconds, after_history, 256)
        local total_calls = small_distance(start_seed, after_history, 320)
        local character_pool = read_pool(CHAR_POOL_DATA)
        local stage_pool = read_pool(STAGE_POOL_DATA)
        local current_stage = ReadValue32(CURRENT_STAGE_DATA)

        append_capture(start_seed, second, after_seconds, after_history,
                       seconds_calls, history_calls, total_calls,
                       character_pool, stage_pool, current_stage)

        last_title_seed = after_history
        btt_captured = false
        status = string.format(
            "title RNG probe: TITLE CAPTURED\nsecond=%d history=%d total=%d\n" ..
            "%08X -> %08X\nnow enter Peach BTT",
            second, history_calls, total_calls, start_seed, after_history)
        clear_capture()
    end

    local targets_left = ReadValue8(TARGETS_LEFT_ADDR)
    if last_title_seed ~= nil and not btt_captured and targets_left == 10 and
       last_targets_left ~= 10 then
        local stage_loaded_seed = ReadValue32(RNG_ADDR)
        append_btt_capture(last_title_seed, stage_loaded_seed)
        btt_captured = true
        status = string.format(
            "title RNG probe: BTT CAPTURED\n%08X -> pre-stage %08X",
            last_title_seed, stage_loaded_seed)
    end
    last_targets_left = targets_left
    SetScreenText(status)
end
