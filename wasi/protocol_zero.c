/*
 * protocol_zero.c - Protocol Zero, CnCNet's latency control for online play,
 * as yrpp-spawner has it (src/Spawner/ProtocolZero*.cpp; GPL-3.0, read for its
 * findings, written anew here), and a log of the network's timing in either
 * protocol. The sites in the game that call here are lift/run_lift.py's
 * protocol_zero_patches; docs/online.md says what each does and how it was
 * measured.
 *
 * What it does. Every player sends, every 30 frames, an event of a type the
 * game lacks (0x30: its response time + 1 as a MaxAhead, and the latency level
 * that response time falls in). Every machine executes those events in step,
 * the same frame on each, keeps each house's last one and drops those older
 * than 120 frames, takes the worst MaxAhead (for IPX's resend timing) and the
 * highest level, and raises its level to that one if it is higher (never
 * lower in a game). A raise sets the precalculated timing, which the first
 * live human sends as a TIMING event at its next QueueAI (MaxAhead from the
 * level's table, FrameSendRate the level, 60 fps): all machines take it on
 * the same frame. The real TIMING each 256 frames still sets the frame rate
 * from the slowest machine's, with MaxAhead and FrameSendRate kept.
 *
 * Where it differs from the spawner, and why:
 * - Its state starts again with each LAN game (ra2_pz_game_start). The
 *   spawner runs one game in a process, its statics starting from their
 *   initial values; a page plays one game after another.
 * - An event of a house past 8 is left alone (the spawner would write past
 *   its arrays; a game has no such house).
 * - The message has no "CnCNet: " in front; this is not CnCNet.
 * - --protocol-zero off: the game's own timing, for measuring the two.
 *
 * The log ("[pz]", "[net]", with --debuglog or a test's script; a game's start
 * and a level raised always): the timing set, each change of MaxAhead,
 * FrameSendRate and frame rate, every 300 frames the frame rate and the time
 * spent waiting for the other players (in all, the longest wait, the waits
 * over 50 ms: a hitch one sees), the input delay of the player's own
 * PROCESS_TIME events (made each 128 frames, carried as every command is).
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "win32hle.h"

void ra2_log(int always, const char *fmt, ...) __attribute__((format(printf, 2, 3)));   /* main.c */
int  ra2_log_on(void);
void ra2web_net_counts(uint32_t *out, uint32_t *in);                                     /* net.c */

/* The game's (gamemd.exe 1.001, the addresses YRpp has; each checked in IDA) */
#define SESSION_MODE        0xA8B238u   /* SessionClass::GameMode: 0 campaign, 3 LAN, 4 internet, 5 skirmish */
#define PROTOCOL_VERSION    0xA8B24Cu   /* 2: events compressed, sent on frames a multiple of FrameSendRate */
#define MAX_AHEAD           0xA8B550u
#define FRAME_SEND_RATE     0xA8B554u
#define REQUESTED_FPS       0xA8B558u
#define MAX_MAX_AHEAD       0xA8B568u
#define PRECALC_MAX_AHEAD   0xA8B56Cu
#define PRECALC_FRAME_RATE  0xA8B570u
#define LATENCY_FUDGE       0xA8DB9Cu
#define CURRENT_FRAME       0xA8ED84u
#define CURRENT_PLAYER      0xA83D4Cu   /* HouseClass*, its ArrayIndex at +0x30 */
#define IPX_MANAGER         0xA8E9C0u
#define IPX_RESPONSE_TIME   0x00542450u /* thiscall: the worst of its connections' mean ack time, in 16 ms */
#define IPX_SET_TIMING      0x00540C60u /* thiscall (retry delta, max retries, timeout, all) */
#define OUT_LIST            0xA802C8u   /* QueueClass<EventClass, 128>: Count, Head, Tail, Array, Timings */
#define OUT_LIST_ARRAY      (OUT_LIST + 0x0Cu)
#define OUT_LIST_TIMINGS    (OUT_LIST + 0x0Cu + 128u * EVENT_SIZE)
#define TIME_GET_TIME_IAT   0x7E1530u   /* the game's import of winmm's timeGetTime */
#define RULES               0x8871E0u   /* RulesClass*; MessageDelay (minutes, a double) at +0x14C0 */
#define MESSAGE_LIST        0xA8BC60u
#define ADD_MESSAGE         0x005D3BA0u /* thiscall (label, 0, text, color scheme, print type, frames, silent) */
#define COLOR_WHITE         5u
#define TEXT_PRINT_TYPE     0x4046u     /* the game's own for its messages (0x4C7FE5) */
#define EVENT_SIZE          111u        /* Type, IsExecuted, HouseIndex, Frame (u32), data[104] */
#define EVENT_RESPONSE_TIME2 0x30u
#define EVENT_PROCESS_TIME  0x21u

/* Protocol Zero's constants (the spawner's) */
#define SEND_INTERVAL       30          /* frames between a player's response times */
#define FIRST_SEND          (8 * SEND_INTERVAL)
#define KEEP_FRAMES         (FIRST_SEND / 2)
#define LEVEL_MAX           9
static const int k_max_ahead[LEVEL_MAX + 1] = { 1, 4, 6, 12, 16, 20, 24, 28, 32, 36 };
static const char *const k_level_name[LEVEL_MAX + 1] = {
    "Initial", "Best", "Super", "Excellent", "Very Good", "Good", "Good", "Default", "Default", "Default",
};

/* Read by the patches */
int      ra2_pz_on;                    /* this game's: set at its start */
int      ra2_pz_worst_max_ahead = 24;  /* k_max_ahead[6] */
uint8_t  ra2_pz_new_frame_send_rate = 3;
uint32_t ra2_pz_name_va;               /* "RESPONSE_TIME2", in guest memory */

static int     g_option = 1;           /* --protocol-zero on|off */
static int     g_next_send = -1;
static uint8_t g_level, g_max_level = LEVEL_MAX;
static int32_t g_house_max_ahead[8], g_house_last_frame[8];
static uint8_t g_house_level[8];
static uint32_t g_message_va;          /* a buffer for the message's text, in guest memory */

void ra2_pz_option(int on) { g_option = on; }

static int single_player(void) {       /* SessionClass::IsSingleplayer */
    uint32_t mode = MEM32(SESSION_MODE);
    return mode == 0 || mode == 5;
}

/* A thiscall into the game, the registers kept (hle_call_guest keeps them all
 * but sets none: ecx is set here and put back). */
static uint32_t guest_thiscall(uint32_t va, uint32_t self, int n, const uint32_t *args) {
    uint32_t ecx = g_ecx;
    g_ecx = self;
    uint32_t r = hle_call_guest(va, n, args);
    g_ecx = ecx;
    return r;
}

static uint8_t level_from_response_time(uint8_t rsp) {
    for (int i = 1; i < LEVEL_MAX; i++)
        if (rsp <= k_max_ahead[i]) return (uint8_t)i;
    return LEVEL_MAX;
}

/* EventClass::OutList.Add, as the game does it inline (0x64779D): the event
 * copied in, the time it was queued, the tail moved on. */
static int out_list_add(const uint8_t *ev) {
    int32_t count = (int32_t)MEM32(OUT_LIST);
    uint32_t tail = MEM32(OUT_LIST + 8u);
    if (count >= 128) return 0;
    memcpy(hle_ptr(OUT_LIST_ARRAY + EVENT_SIZE * tail), ev, EVENT_SIZE);
    MEM32(OUT_LIST_TIMINGS + 4u * tail) = hle_call_guest(MEM32(TIME_GET_TIME_IAT), 0, NULL);
    MEM32(OUT_LIST + 8u) = (tail + 1u) & 127u;
    MEM32(OUT_LIST) = (uint32_t)(count + 1);
    return 1;
}

static void print_message(uint8_t level) {
    if (!g_message_va) g_message_va = hle_va(hle_alloc(128 * 2));
    if (!g_message_va || !MEM32(RULES)) return;
    char text[96];
    int n = snprintf(text, sizeof text, "Latency mode set to: %d - %s", level, k_level_name[level]);
    for (int i = 0; i <= n && i < 127; i++) MEM16(g_message_va + 2u * i) = (uint8_t)text[i];
    int frames = (int)(MEMD(MEM32(RULES) + 0x14C0u) * 900.0);       /* MessageDelay minutes, at 15 fps */
    uint32_t a[7] = { 0, 0, g_message_va, COLOR_WHITE, TEXT_PRINT_TYPE, (uint32_t)frames, 1 };
    guest_thiscall(ADD_MESSAGE, MESSAGE_LIST, 7, a);
}

static void apply_level(uint8_t level) {
    if (level > LEVEL_MAX) level = LEVEL_MAX;
    if (level > g_max_level) level = g_max_level;
    if (level <= g_level) return;
    ra2_log(1, "[pz] frame %d: latency level %d -> %d (MaxAhead %d, FrameSendRate %d)",
            (int)MEM32(CURRENT_FRAME), g_level, level, k_max_ahead[level], level);
    g_level = level;
    ra2_pz_new_frame_send_rate = level;
    MEM32(PRECALC_FRAME_RATE) = 60;
    MEM32(PRECALC_MAX_AHEAD) = (uint32_t)k_max_ahead[level];
    print_message(level);
}

/* ---- the network's timing, logged (either protocol) ------------------------ */

static struct {
    uint32_t max_ahead, frame_send_rate, fps;
    int      frame0, long_waits;
    double   t0, wait, wait_from, longest;
    uint32_t out0, in0;
} g_net;

static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}
static double wall_s(void) {           /* the wall clock, one for every process here: two players' frames in time */
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (ts.tv_sec % 100000) + ts.tv_nsec / 1e9;
}

static void net_log(void) {
    uint32_t mode = MEM32(SESSION_MODE), frame = MEM32(CURRENT_FRAME);
    if ((mode != 3 && mode != 4) || !ra2_log_on()) return;
    uint32_t ma = MEM32(MAX_AHEAD), fsr = MEM32(FRAME_SEND_RATE), fps = MEM32(REQUESTED_FPS);
    if (ma != g_net.max_ahead || fsr != g_net.frame_send_rate || fps != g_net.fps) {
        ra2_log(0, "[net] frame %u: MaxAhead %u, FrameSendRate %u, frame rate %u; at %.3f s", frame, ma, fsr, fps, wall_s());
        g_net.max_ahead = ma, g_net.frame_send_rate = fsr, g_net.fps = fps;
    }
    double t = now_ms();
    uint32_t out, in;
    ra2web_net_counts(&out, &in);
    if (!g_net.t0 || (int)frame < g_net.frame0) {
        g_net.t0 = t, g_net.frame0 = (int)frame, g_net.wait = 0, g_net.out0 = out, g_net.in0 = in;
        return;
    }
    if ((int)frame - g_net.frame0 >= 300) {
        double ms = t - g_net.t0;
        ra2_log(0, "[net] frame %u: %d frames in %.0f ms (%.1f fps), waited for the others %.0f ms "
                "(longest %.0f ms, %d over 50 ms); datagrams %.0f out, %.0f in a second; at %.3f s", frame,
                (int)frame - g_net.frame0, ms, ((int)frame - g_net.frame0) * 1e3 / ms, g_net.wait, g_net.longest,
                g_net.long_waits, (out - g_net.out0) * 1e3 / ms, (in - g_net.in0) * 1e3 / ms, wall_s());
        g_net.t0 = t, g_net.frame0 = (int)frame, g_net.wait = 0, g_net.longest = 0, g_net.long_waits = 0;
        g_net.out0 = out, g_net.in0 = in;
    }
}

void ra2_net_wait_begin(void) { g_net.wait_from = now_ms(); g_esp += 4; }
void ra2_net_wait_end(void) {
    if (g_net.wait_from) {
        double ms = now_ms() - g_net.wait_from;
        g_net.wait += ms;
        if (ms > g_net.longest) g_net.longest = ms;
        if (ms > 50) g_net.long_waits++;
    }
    g_net.wait_from = 0;
    g_esp += 4;
}

/* ---- what the patches call (each as a lifted function: it pops its return
 * address, and leaves the registers as they were) ---------------------------- */

/* A LAN game's start, its timing just set by the game (0x5DD877) */
void ra2_pz_game_start(void) {
    if (!ra2_pz_name_va) ra2_pz_name_va = hle_guest_strdup("RESPONSE_TIME2");
    g_next_send = -1;
    g_level = 0;                                   /* LATENCY_LEVEL_INITIAL */
    ra2_pz_new_frame_send_rate = 3;
    ra2_pz_worst_max_ahead = k_max_ahead[6];
    g_max_level = LEVEL_MAX;                       /* MaxLatencyLevel 0xFF, clamped to 1..9 */
    memset(g_house_max_ahead, 0, sizeof g_house_max_ahead);
    memset(g_house_level, 0, sizeof g_house_level);
    memset(g_house_last_frame, 0, sizeof g_house_last_frame);
    memset(&g_net, 0, sizeof g_net);
    ra2_pz_on = g_option;
    if (ra2_pz_on) {                               /* the spawner's, for Protocol=0 */
        uint32_t timing[4] = { 60, 0xFFFFFFFFu, 600, 1 };
        guest_thiscall(IPX_SET_TIMING, IPX_MANAGER, 4, timing);
        MEM32(FRAME_SEND_RATE) = 2;
        MEM32(PRECALC_MAX_AHEAD) = 0;
        MEM32(PRECALC_FRAME_RATE) = 0;             /* as the game left it (0x5DD2F0, 0x5DD4B0) */
        MEM32(MAX_AHEAD) = 2 * 6;                  /* MaxAhead -1: FrameSendRate * 6 */
        MEM32(MAX_MAX_AHEAD) = 0;
        MEM32(PROTOCOL_VERSION) = 2;
        MEM32(LATENCY_FUDGE) = 0;
        MEM32(REQUESTED_FPS) = 60;
        /* ReconnectTimeout (0x83737C, the LAN's): 2400 already, the spawner's, nothing writes it */
    }
    ra2_log(1, "[pz] a LAN game starts: Protocol Zero %s; MaxAhead %u, FrameSendRate %u, frame rate %u",
            ra2_pz_on ? "on" : "off", MEM32(MAX_AHEAD), MEM32(FRAME_SEND_RATE), MEM32(REQUESTED_FPS));
    g_esp += 4;
}

/* The main loop, each round after the frame is drawn (0x55DDA0) */
void ra2_pz_main_loop(void) {
    net_log();
    if (ra2_pz_on && !single_player()) {           /* ProtocolZero::SendResponseTime2 */
        int frame = (int)MEM32(CURRENT_FRAME);
        if (g_next_send < 0) {
            g_next_send = frame + (int)MEM32(FRAME_SEND_RATE) + FIRST_SEND;
        } else if (g_next_send < frame) {
            int rsp = (int)guest_thiscall(IPX_RESPONSE_TIME, IPX_MANAGER, 0, NULL);
            uint32_t player = MEM32(CURRENT_PLAYER);
            if (rsp > -1 && player) {
                uint8_t ev[EVENT_SIZE] = { 0 };
                uint32_t at = (uint32_t)frame + MEM32(MAX_AHEAD);   /* packing sets it again (0x64B9A0) */
                ev[0] = EVENT_RESPONSE_TIME2;
                ev[2] = (uint8_t)MEM32(player + 0x30u);
                memcpy(ev + 3, &at, 4);
                ev[7] = (uint8_t)((int)(int8_t)rsp + 1);           /* (int8_t)rsp + 1, kept in a char */
                ev[8] = level_from_response_time((uint8_t)rsp);
                if (out_list_add(ev)) {
                    g_next_send = frame + SEND_INTERVAL;
                    if (ra2_log_on())
                        ra2_log(0, "[pz] frame %d: house %d sends response time %d (MaxAhead %d, level %d)",
                                frame, ev[2], rsp, (int8_t)ev[7], ev[8]);
                } else {
                    ++g_next_send;
                }
            }
        }
    }
    g_esp += 4;
}

/* EventClass::Execute, for 0x30 and PROCESS_TIME (0x4C6CC8; esi the event) */
void ra2_pz_respond(void) {
    uint32_t ev = g_esi, frame = MEM32(CURRENT_FRAME), player = MEM32(CURRENT_PLAYER);
    int house = (int8_t)MEM8(ev + 2);
    if (MEM8(ev) == EVENT_PROCESS_TIME) {          /* the log's input delay: made on a frame a multiple of 128 */
        if (ra2_log_on() && player && house == (int)MEM32(player + 0x30u) && MEM32(SESSION_MODE) >= 3 &&
            MEM32(SESSION_MODE) <= 4)
            ra2_log(0, "[net] frame %u: own PROCESS_TIME made on frame %u executes: input delay %u frames", frame,
                    frame & ~127u, frame & 127u);
        g_esp += 4;
        return;
    }
    if (ra2_pz_on && !single_player()) {           /* ProtocolZero::HandleResponseTime2 */
        int8_t max_ahead = (int8_t)MEM8(ev + 7);
        if (max_ahead == 0) {
            if (ra2_log_on()) ra2_log(0, "[pz] frame %u: house %d's response time event has MaxAhead 0: not taken", frame, house);
        } else if (house >= 0 && house < 8) {
            g_house_max_ahead[house] = max_ahead;
            g_house_level[house] = MEM8(ev + 8);
            g_house_last_frame[house] = (int32_t)MEM32(ev + 3);
            uint8_t level = 0;
            int worst = 0;
            for (int i = 0; i < 8; i++) {
                if ((int)frame >= g_house_last_frame[i] + KEEP_FRAMES) {
                    g_house_max_ahead[i] = 0, g_house_level[i] = 0;
                } else {
                    if (g_house_max_ahead[i] > worst) worst = g_house_max_ahead[i];
                    if (g_house_level[i] > level) level = g_house_level[i];
                }
            }
            ra2_pz_worst_max_ahead = worst;
            apply_level(level);
        }
    }
    g_esp += 4;
}

/* Execute_DoList: an EMPTY, PROCESS_TIME or 0x30 event executed late (0x64C598; esi the event) */
void ra2_pz_late(void) {
    if (ra2_log_on())
        ra2_log(0, "[pz] frame %u: a late event 0x%02X of house %d (frame %u) executed all the same",
                MEM32(CURRENT_FRAME), MEM8(g_esi), (int8_t)MEM8(g_esi + 2), MEM32(g_esi + 3));
    g_esp += 4;
}

/* QueueAI_Multiplayer sets IPX's timing (0x64771D, 0x647E6B: its arguments pushed) */
void ra2_pz_log_timing(void) {
    if (ra2_log_on())
        ra2_log(0, "[pz] frame %u: IPX timing: retry delta %u, timeout %u; FrameSendRate %u, latency level %d",
                MEM32(CURRENT_FRAME), MEM32(g_esp + 4u), MEM32(g_esp + 12u), MEM32(FRAME_SEND_RATE), g_level);
    g_esp += 4;
}
