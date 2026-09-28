/* Exact T10 1.11.0 callback patch. PTRACE_POKETEXT uses the kernel's
 * executable-page write path (including instruction-cache maintenance).
 * Never changes the library on disk or restarts the firmware process. */
#define _GNU_SOURCE
#include <sys/ptrace.h>
#include <sys/wait.h>
#include <sys/mman.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <signal.h>
#define ORIGINAL 0xd10843ffU
#define DISABLED 0xd65f03c0U
#define LIBRARY "/usr/lib/node/liberos_node_job_schedule.so"

static int patch(pid_t pid, uintptr_t address, uint32_t from, uint32_t to) {
    int status, result = 1, stopped = 0;
    unsigned shift=(address & 7)*8;
    address &= ~(uintptr_t)7;
    /* SEIZE does not inject SIGSTOP or restart/kill any firmware thread. */
    if (ptrace(PTRACE_SEIZE, pid, 0, 0) < 0) { perror("seize"); return 1; }
    if (ptrace(PTRACE_INTERRUPT, pid, 0, 0) < 0) { perror("interrupt"); goto done; }
    for (int i=0; i<200; i++) {
        pid_t got=waitpid(pid, &status, __WALL|WNOHANG);
        if (got==pid) { stopped=WIFSTOPPED(status); break; }
        if (got<0) break;
        usleep(1000);
    }
    if (!stopped) { fprintf(stderr,"No bounded ptrace stop\n"); goto done; }
    errno=0;
    unsigned long word=(unsigned long)ptrace(PTRACE_PEEKTEXT,pid,(void *)address,0);
    if (errno) { perror("peek"); goto done; }
    if ((uint32_t)(word>>shift)==to) { result=0; goto done; }
    if ((uint32_t)(word>>shift)!=from) { fprintf(stderr,"Unexpected live instruction\n"); goto done; }
    unsigned long replacement=(word & ~(0xffffffffUL<<shift)) | ((unsigned long)to<<shift);
    if (ptrace(PTRACE_POKETEXT,pid,(void *)address,(void *)replacement)<0) { perror("poke"); goto done; }
    errno=0;
    unsigned long actual=(unsigned long)ptrace(PTRACE_PEEKTEXT,pid,(void *)address,0);
    if (errno || actual!=replacement) {
        ptrace(PTRACE_POKETEXT,pid,(void *)address,(void *)word);
        fprintf(stderr,"Verification failed; restored original word\n"); goto done;
    }
    result=0;
done:
    if (ptrace(PTRACE_DETACH,pid,0,0)<0) { perror("detach"); result=1; }
    return result;
}

/* Exercise executable-page patching and cache coherence in our own child,
 * never in the firmware. Child runs the same callback before/after/restore. */
static int selftest(void) {
    uint32_t *code=mmap(0,4096,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if (code==MAP_FAILED) return 1;
    uint32_t instructions[]={ORIGINAL,0x52800540U,0x910843ffU,DISABLED};
    memcpy(code,instructions,sizeof(instructions));
    __builtin___clear_cache((char *)code,(char *)code+sizeof(instructions));
    int cmd[2],answer[2]; if(pipe(cmd)||pipe(answer)) return 1;
    pid_t child=fork(); if(child<0) return 1;
    if(!child) {
        close(cmd[1]);close(answer[0]);char c;
        while(read(cmd[0],&c,1)==1) {
            int (*fn)(int)=(int (*)(int))code; int value=fn(7);
            if(write(answer[1],&value,sizeof(value))!=sizeof(value)) _exit(2);
        }
        _exit(0);
    }
    close(cmd[0]);close(answer[1]);int result=0;
    for(int step=0;step<3;step++) {
        if(step && patch(child,(uintptr_t)code,step==1?ORIGINAL:DISABLED,step==1?DISABLED:ORIGINAL)) {result=1;break;}
        int value=0;
        if(write(cmd[1],"x",1)!=1 || read(answer[0],&value,sizeof(value))!=sizeof(value) || value!=(step==1?7:42)) {result=1;break;}
    }
    close(cmd[1]);waitpid(child,0,0);
    puts(result?"selftest failed":"selftest passed: executable callback 42 -> 7 -> 42");return result;
}
int main(int argc,char **argv) {
    if(argc==2 && !strcmp(argv[1],"selftest")) return selftest();
    if(argc!=3 || (strcmp(argv[2],"enable") && strcmp(argv[2],"disable"))) return 2;
    char *end;long parsed=strtol(argv[1],&end,10);if(*end || parsed<=1 || parsed>0x7fffffff) return 2;
    pid_t pid=(pid_t)parsed; char path[128],line[1024];
    snprintf(path,sizeof(path),"/proc/%d/maps",pid); FILE *maps=fopen(path,"r");if(!maps) return 1;
    uintptr_t addresses[2]={0,0};
    const unsigned long offsets[2]={0x24590,0x2dad4};
    const uint32_t originals[2]={ORIGINAL,0x540001e0U};
    const uint32_t replacements[2]={DISABLED,0xd503201fU};
    unsigned long start,finish,offset;char perms[8],file[512];
    while(fgets(line,sizeof(line),maps)) {
        if(sscanf(line,"%lx-%lx %7s %lx %*s %*s %511s",&start,&finish,perms,&offset,file)==5
           && !strcmp(file,LIBRARY) && strchr(perms,'x'))
            for(int i=0;i<2;i++) if(offset<=offsets[i] && offsets[i]-offset<finish-start)
                addresses[i]=start+offsets[i]-offset;
    }
    fclose(maps);if(!addresses[0] || !addresses[1] || addresses[0]%4 || addresses[1]%4) {fputs("Pinned callback mapping absent\n",stderr);return 1;}
    int enable=!strcmp(argv[2],"enable");
    for(int i=0;i<2;i++)
        if(patch(pid,addresses[i],enable?originals[i]:replacements[i],enable?replacements[i]:originals[i])) return 1;
    return 0;
}
