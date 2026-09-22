// Command dc-status sets your Discord custom status bubble.
//
// Edit status below, then run: go run .
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	status = "" // change this to whatever you want; "" clears the status
	emoji  = ""        // optional unicode emoji shown before the text, e.g. "📚"
)

type customStatus struct {
	Text      string `json:"text,omitzero"`
	EmojiName string `json:"emoji_name,omitzero"`
}

// A nil CustomStatus marshals to null, which is how Discord clears the bubble.
type settings struct {
	CustomStatus *customStatus `json:"custom_status"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "✗", err)
		os.Exit(1)
	}
}

func run() error {
	token, err := loadToken()
	if err != nil {
		return err
	}

	var payload settings
	if status != "" || emoji != "" {
		payload.CustomStatus = new(customStatus{Text: status, EmojiName: emoji})
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encoding payload: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPatch,
		"https://discord.com/api/v9/users/@me/settings", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("building request: %w", err)
	}
	req.Header.Set("Authorization", token)
	req.Header.Set("Content-Type", "application/json")
	// Discord rejects requests without a browser-looking user agent.
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("calling Discord: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		if resp.StatusCode == http.StatusUnauthorized {
			return fmt.Errorf("Discord says the token is invalid (401). Re-copy it into .env")
		}
		return fmt.Errorf("Discord returned %d: %s", resp.StatusCode, detail)
	}

	if payload.CustomStatus == nil {
		fmt.Println("✓ custom status cleared")
		return nil
	}
	fmt.Printf("✓ custom status set to: %s\n", strings.TrimSpace(emoji+" "+status))
	return nil
}

// loadToken reads DISCORD_TOKEN from the .env file next to the binary's source.
func loadToken() (string, error) {
	path := ".env"
	if exe, err := os.Executable(); err == nil {
		if _, statErr := os.Stat(path); statErr != nil {
			path = filepath.Join(filepath.Dir(exe), ".env")
		}
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("no .env file found next to the program.\n" +
			"Create one containing:\nDISCORD_TOKEN=your_token_here")
	}

	for line := range strings.SplitSeq(string(data), "\n") {
		if rest, ok := strings.CutPrefix(strings.TrimSpace(line), "DISCORD_TOKEN="); ok {
			return strings.Trim(strings.TrimSpace(rest), `"'`), nil
		}
	}
	return "", fmt.Errorf("DISCORD_TOKEN not found in %s", path)
}
