// The multiplayer relay for the browser build of Yuri's Revenge: a virtual LAN
// on a server the players can all reach.
//
// A page that plays online connects here by WebSocket (/net) and becomes a host
// on a virtual LAN, 10.47.0.0/16: the game's own LAN play (its IPX, carried as
// UDP the way IPXEmu carries it: wasi/net.c) goes through this server, so the
// game's own Network lobby lists every game hosted on the same LAN, and a game
// is played through it. The pages decide everything a host's IP stack would
// (wasi/net.c); this server only hands out addresses and switches datagrams.
//
//	go run . [-addr :8790] [-tls-cert FILE -tls-key FILE (SIGHUP reads them again)] [-origins PATTERN,...]
//	         [-max-clients N] [-max-lan N] [-test-delay D -test-jitter D -test-loss PCT]
//
// Joining: the first message is text, a JSON hello:
//
//	{"t":"hello","v":1,"build":HEX,"name":NAME,"client":ID,"lan":LAN,"token":TOKEN}
//
// build: the game module's id (the page's hash of out/ra2.wasm): a LAN is a
// name and a build, so only players running the same module meet (lockstep
// play needs every peer to compute the same). name: the player's name, unique
// in the LAN (the game tells players apart by it). client: the browser's own
// id (localStorage): one page per browser on a LAN. lan: which LAN, "main" if
// none. token: given on a reconnect, the address and name held for it.
// The answer: {"t":"welcome","ip":"10.47.0.5","mask":"255.255.0.0","token":T,
// "peers":[{"ip","name"}]} or {"t":"refused","why":"name|client|full|version|bad"}
// and the connection closed. While joined, {"t":"peers","peers":[...]} each
// time someone comes or goes; {"t":"ping","n":N} from a page is answered
// {"t":"pong","n":N}, to it alone (its round trip to the relay, for the page
// to show).
//
// Datagrams are binary frames, big-endian:
//
//	page -> relay  [0]=1 [1..4] destination [5..6] source port [7..8] destination port [9..] payload
//	relay -> page  [0]=1 [1..4] source      [5..6] source port [7..8] destination port [9..] payload
//
// ([0]=2 relay -> page: the same, sent as a broadcast; the page counts what it
// drops of each apart)
//
// The relay fills in the source itself (no page can speak for another). A
// destination of 255.255.255.255 or 10.47.255.255 goes to every page on the
// LAN, the sender too: Windows hands a host its own broadcasts back, and the
// game's lobby is written for that. Payloads above 1472 bytes (an Ethernet
// frame's UDP payload; the game sends at most ~580) are dropped, as are
// datagrams past a page's rate.
//
// A page that drops keeps its address and name for 60 s: a reconnect with its
// token gets them back, and the game, which only sees datagrams, goes on.
// The server pings every page each 15 s and closes one that does not answer.
// GET /status: the LANs, who is on them and what they sent (broadcast or to
// one address) and what of it was dropped, as JSON.
//
// -test-delay, -test-jitter, -test-loss: for measuring the game over a path
// like the internet's, not for play. Each datagram handed to a page waits the
// delay, give or take up to the jitter (in their order still), or is lost by
// the percentage. A datagram passes the relay once: the round trip between two
// pages is twice the delay.
package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	mrand "math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

const (
	netBase      = 0x0A2F0000 // 10.47.0.0
	netMask      = 0xFFFF0000
	netBroadcast = netBase | ^uint32(netMask)
	maxPayload   = 1472
	frameHeader  = 9
	holdFor      = 60 * time.Second
	pingEvery    = 15 * time.Second
	pingWait     = 10 * time.Second
	helloWait    = 10 * time.Second
	sendQueue    = 512
	// a page's rate, far more than the game sends: in a game of 8, a datagram a frame to each of
	// the 7 others with Protocol Zero at its first level (FrameSendRate 1), ~440 a second at 60 fps
	// (329 measured at 45 fps, 366 at most; 66 with the game's own timing; docs/online.md)
	ratePackets = 1000
	rateBytes   = 1 << 20
)

var (
	addr    = flag.String("addr", ":8790", "where to listen")
	tlsCert = flag.String("tls-cert", "", "TLS certificate (PEM): wss:// for pages served over HTTPS")
	tlsKey  = flag.String("tls-key", "", "TLS key (PEM)")
	origins = flag.String("origins", "*", "the page origins allowed (host patterns, comma-separated)")
	// The game has no limit: a LAN is the game's lobby, not one game, and its rooms take 8 players
	// each, the lobby any number (netdlg2.cpp's lists grow as they need). What bounds it is this
	// server's bandwidth: each page in the lobby broadcasts ~1.3 datagrams a second (~475 bytes),
	// handed to every page, N pages N*N of them a second (docs/online.md): 128, ~10 MB/s at most.
	maxClients = flag.Int("max-clients", 128, "pages on the server at most (0: no limit)")
	maxLAN     = flag.Int("max-lan", 0, "pages on one LAN at most (its lobby; 0: no limit)")

	testDelay  = flag.Duration("test-delay", 0, "tests: each datagram to a page held this long (the round trip: twice it)")
	testJitter = flag.Duration("test-jitter", 0, "tests: the hold varied by up to this either way, the order kept")
	testLoss   = flag.Float64("test-loss", 0, "tests: this percentage of the datagrams to pages lost")

	validName  = regexp.MustCompile(`^[A-Za-z0-9 _-]{1,16}$`)
	validBuild = regexp.MustCompile(`^[0-9a-f]{8,64}$`)
	validLAN   = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)
	validID    = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)
)

type hello struct {
	T      string `json:"t"`
	V      int    `json:"v"`
	Build  string `json:"build"`
	Name   string `json:"name"`
	Client string `json:"client"`
	LAN    string `json:"lan"`
	Token  string `json:"token"`
}

type peer struct {
	IP   string `json:"ip"`
	Name string `json:"name"`
}

// a page on a LAN; conn is nil while it is held for a reconnect
type member struct {
	ip     uint32
	name   string
	client string
	token  string
	lan    *lan
	conn   *websocket.Conn
	send   chan outFrame
	gone   time.Time
	due    time.Time // -test-delay: when its last datagram is due
	// rate: a second's window
	window  time.Time
	packets int
	bytes   int
}

// a frame to a page: [0]=0 text (the rest JSON), else a datagram; due: held till then (-test-delay)
type outFrame struct {
	b   []byte
	due time.Time
}

type lan struct {
	name, build string
	byIP        map[uint32]*member
	nextIP      uint32
	traffic     traffic
}

// what a LAN's pages sent since it began (GET /status), payload bytes
type traffic struct {
	Broadcast      uint64 `json:"broadcast"` // datagrams to every page on the LAN
	BroadcastBytes uint64 `json:"broadcastBytes"`
	Unicast        uint64 `json:"unicast"` // to one address on it
	UnicastBytes   uint64 `json:"unicastBytes"`
	Delivered      uint64 `json:"delivered"` // datagrams handed to pages: a broadcast once for each
	// dropped: past the sender's rate (ratePackets, rateBytes), a page's queue full, lost by -test-loss
	OverRate  uint64 `json:"overRate"`
	QueueFull uint64 `json:"queueFull"`
	TestLost  uint64 `json:"testLost"`
}

type hub struct {
	mu     sync.Mutex
	lans   map[string]*lan
	tokens map[string]*member
	conns  int
}

var h = &hub{lans: map[string]*lan{}, tokens: map[string]*member{}}

func ipString(ip uint32) string {
	return fmt.Sprintf("%d.%d.%d.%d", ip>>24, ip>>16&255, ip>>8&255, ip&255)
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (l *lan) peers() []peer {
	out := []peer{}
	for _, m := range l.byIP {
		if m.conn != nil {
			out = append(out, peer{ipString(m.ip), m.name})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].IP < out[j].IP })
	return out
}

// an address no one holds: 10.47.0.2 and on, never a .0 or .255
func (l *lan) allocate() uint32 {
	for range 1 << 16 {
		l.nextIP++
		ip := netBase | l.nextIP&^netMask
		if ip&255 == 0 || ip&255 == 255 || ip&^netMask < 2 || ip == netBroadcast {
			continue
		}
		if _, used := l.byIP[ip]; !used {
			return ip
		}
	}
	return 0
}

// tell everyone on the LAN who is there (under h.mu)
func (l *lan) announce() {
	msg, _ := json.Marshal(map[string]any{"t": "peers", "peers": l.peers()})
	for _, m := range l.byIP {
		if m.conn != nil {
			select {
			case m.send <- outFrame{b: append([]byte{0}, msg...)}: // 0: text, the rest JSON
			default:
			}
		}
	}
}

// join or rejoin; the reason a page is refused otherwise
func (h *hub) join(hi hello, conn *websocket.Conn) (*member, string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	key := hi.LAN + "/" + hi.Build
	l := h.lans[key]
	if l == nil {
		// a LAN of the same name on another build: a page whose module differs from its friends'
		for _, other := range h.lans {
			if other.name == hi.LAN && len(other.peers()) > 0 {
				return nil, "version"
			}
		}
		l = &lan{name: hi.LAN, build: hi.Build, byIP: map[uint32]*member{}}
		h.lans[key] = l
	}
	if m := h.tokens[hi.Token]; hi.Token != "" && m != nil && m.lan == l && m.client == hi.Client {
		if m.conn != nil {
			m.conn.Close(websocket.StatusPolicyViolation, "replaced by a reconnect")
		}
		m.conn, m.send, m.gone = conn, make(chan outFrame, sendQueue), time.Time{}
		h.conns++
		l.announce()
		return m, ""
	}
	if *maxClients > 0 && h.conns >= *maxClients {
		return nil, "full"
	}
	live := 0
	for _, m := range l.byIP {
		if m.client == hi.Client && m.conn != nil {
			return nil, "client"
		}
		if strings.EqualFold(m.name, hi.Name) {
			return nil, "name"
		}
		if m.conn != nil {
			live++
		}
	}
	if *maxLAN > 0 && live >= *maxLAN {
		return nil, "full"
	}
	ip := l.allocate()
	if ip == 0 {
		return nil, "full"
	}
	m := &member{ip: ip, name: hi.Name, client: hi.Client, token: randomHex(16), lan: l, conn: conn, send: make(chan outFrame, sendQueue)}
	l.byIP[ip] = m
	h.tokens[m.token] = m
	h.conns++
	l.announce()
	return m, ""
}

// the page's connection went: held for a reconnect, then let go
func (h *hub) leave(m *member, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if m.conn != conn {
		return // replaced by a reconnect already
	}
	m.conn, m.gone = nil, time.Now()
	h.conns--
	m.lan.announce()
	go func() {
		time.Sleep(holdFor)
		h.mu.Lock()
		defer h.mu.Unlock()
		if m.conn == nil && time.Since(m.gone) >= holdFor {
			delete(m.lan.byIP, m.ip)
			delete(h.tokens, m.token)
			if len(m.lan.byIP) == 0 {
				delete(h.lans, m.lan.name+"/"+m.lan.build)
			}
		}
	}()
}

// a datagram from m: to its destination, or to everyone on the LAN
func (h *hub) route(m *member, frame []byte) {
	if len(frame) < frameHeader || frame[0] != 1 || len(frame)-frameHeader > maxPayload {
		return
	}
	now := time.Now()
	if now.Sub(m.window) >= time.Second {
		m.window, m.packets, m.bytes = now, 0, 0
	}
	m.packets++
	m.bytes += len(frame)
	over := m.packets > ratePackets || m.bytes > rateBytes
	dst := binary.BigEndian.Uint32(frame[1:5])
	out := make([]byte, len(frame))
	copy(out, frame)
	binary.BigEndian.PutUint32(out[1:5], m.ip)
	h.mu.Lock()
	defer h.mu.Unlock()
	t, n := &m.lan.traffic, uint64(len(frame)-frameHeader)
	if over {
		t.OverRate++
		return
	}
	deliver := func(to *member) {
		if to.conn == nil {
			return
		}
		if *testLoss > 0 && mrand.Float64()*100 < *testLoss {
			t.TestLost++
			return
		}
		f := outFrame{b: out}
		if *testDelay > 0 || *testJitter > 0 {
			d := *testDelay
			if *testJitter > 0 {
				d += time.Duration(mrand.Int64N(int64(2**testJitter)+1)) - *testJitter
			}
			f.due = now.Add(d)
			if f.due.Before(to.due) { // a datagram is not passed by a later one
				f.due = to.due
			}
			to.due = f.due
		}
		select {
		case to.send <- f:
			t.Delivered++
		default: // its queue is full: a datagram lost, as on a LAN
			t.QueueFull++
		}
	}
	if dst == 0xFFFFFFFF || dst == netBroadcast {
		out[0] = 2
		t.Broadcast, t.BroadcastBytes = t.Broadcast+1, t.BroadcastBytes+n
		for _, to := range m.lan.byIP {
			deliver(to)
		}
	} else if to := m.lan.byIP[dst]; to != nil {
		t.Unicast, t.UnicastBytes = t.Unicast+1, t.UnicastBytes+n
		deliver(to)
	}
}

func serveNet(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns:  strings.Split(*origins, ","),
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(4096)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	hctx, hcancel := context.WithTimeout(ctx, helloWait)
	typ, data, err := conn.Read(hctx)
	hcancel()
	var hi hello
	if err != nil || typ != websocket.MessageText || json.Unmarshal(data, &hi) != nil || hi.T != "hello" || hi.V != 1 {
		refuse(ctx, conn, "bad")
		return
	}
	if hi.LAN == "" {
		hi.LAN = "main"
	}
	if !validName.MatchString(hi.Name) || !validBuild.MatchString(hi.Build) || !validLAN.MatchString(hi.LAN) || !validID.MatchString(hi.Client) {
		refuse(ctx, conn, "bad")
		return
	}
	m, why := h.join(hi, conn)
	if m == nil {
		log.Printf("[relay] %s %q refused: %s", r.RemoteAddr, hi.Name, why)
		refuse(ctx, conn, why)
		return
	}
	h.mu.Lock()
	welcome, _ := json.Marshal(map[string]any{"t": "welcome", "ip": ipString(m.ip), "mask": "255.255.0.0",
		"token": m.token, "lan": hi.LAN, "peers": m.lan.peers()})
	send := m.send
	h.mu.Unlock()
	log.Printf("[relay] %s %q is %s on %s/%s", r.RemoteAddr, m.name, ipString(m.ip), hi.LAN, hi.Build[:8])
	defer func() {
		h.leave(m, conn)
		log.Printf("[relay] %q (%s) left", m.name, ipString(m.ip))
	}()
	if conn.Write(ctx, websocket.MessageText, welcome) != nil {
		return
	}

	// the writer: the page's queue, and a ping each 15 s
	go func() {
		defer cancel()
		ping := time.NewTicker(pingEvery)
		defer ping.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case f := <-send:
				if !f.due.IsZero() {
					time.Sleep(time.Until(f.due))
				}
				b, typ := f.b, websocket.MessageBinary
				if b[0] == 0 {
					typ, b = websocket.MessageText, b[1:]
				}
				if conn.Write(ctx, typ, b) != nil {
					return
				}
			case <-ping.C:
				pctx, pcancel := context.WithTimeout(ctx, pingWait)
				err := conn.Ping(pctx)
				pcancel()
				if err != nil {
					return
				}
			}
		}
	}()
	// the reader: datagrams (pings are answered while it reads)
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageBinary {
			h.route(m, data)
		} else if typ == websocket.MessageText {
			var c struct {
				T string  `json:"t"`
				N float64 `json:"n"`
			}
			if json.Unmarshal(data, &c) == nil && c.T == "ping" {
				pong, _ := json.Marshal(map[string]any{"t": "pong", "n": c.N})
				select {
				case send <- outFrame{b: append([]byte{0}, pong...)}:
				default:
				}
			}
		}
	}
}

func refuse(ctx context.Context, conn *websocket.Conn, why string) {
	msg, _ := json.Marshal(map[string]string{"t": "refused", "why": why})
	wctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	conn.Write(wctx, websocket.MessageText, msg)
	conn.Close(websocket.StatusPolicyViolation, why)
}

func serveStatus(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	type lanStatus struct {
		LAN     string  `json:"lan"`
		Build   string  `json:"build"`
		Peers   []peer  `json:"peers"`
		Traffic traffic `json:"traffic"`
	}
	out := []lanStatus{}
	for _, l := range h.lans {
		out = append(out, lanStatus{l.name, l.build, l.peers(), l.traffic})
	}
	h.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
	json.NewEncoder(w).Encode(map[string]any{"lans": out})
}

// The certificate and its key, read again on SIGHUP: an ACME client's renewal hook tells the relay
// so (pkill -HUP -x relay). A certificate is so renewed without a restart,
// which would drop every page and the games on it; the pages joined stay, and the next handshake
// has the new one. One that fails to load leaves the last one in use.
type certFiles struct {
	cert, key string
	mu        sync.RWMutex
	cur       *tls.Certificate
}

func (c *certFiles) load() error {
	pair, err := tls.LoadX509KeyPair(c.cert, c.key)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.cur = &pair
	c.mu.Unlock()
	return nil
}

func (c *certFiles) get(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.cur, nil
}

func main() {
	flag.Parse()
	http.HandleFunc("/net", serveNet)
	http.HandleFunc("/status", serveStatus)
	srv := &http.Server{Addr: *addr, ReadHeaderTimeout: 10 * time.Second}
	if *testDelay > 0 || *testJitter > 0 || *testLoss > 0 {
		log.Printf("[relay] TEST conditions: each datagram held %v (+-%v), %.1f%% lost", *testDelay, *testJitter, *testLoss)
	}
	var err error
	if *tlsCert != "" {
		cf := &certFiles{cert: *tlsCert, key: *tlsKey}
		if err := cf.load(); err != nil {
			log.Fatalf("[relay] the certificate: %v", err)
		}
		hup := make(chan os.Signal, 1)
		signal.Notify(hup, syscall.SIGHUP)
		go func() {
			for range hup {
				if err := cf.load(); err != nil {
					log.Printf("[relay] SIGHUP: the certificate does not load (%v): the last one kept", err)
				} else {
					log.Printf("[relay] SIGHUP: the certificate read again: %s", *tlsCert)
				}
			}
		}()
		srv.TLSConfig = &tls.Config{GetCertificate: cf.get}
		log.Printf("[relay] wss://%s/net (SIGHUP reads the certificate again)", *addr)
		err = srv.ListenAndServeTLS("", "")
	} else {
		log.Printf("[relay] ws://%s/net", *addr)
		err = srv.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
