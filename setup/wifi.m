#import <Foundation/Foundation.h>
#import <CoreWLAN/CoreWLAN.h>
static void emit(NSDictionary *value) {
    NSData *json=[NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    fwrite(json.bytes,1,json.length,stdout);fputc('\n',stdout);fflush(stdout);
}
int main(int argc,const char **argv) { @autoreleasepool {
    if(argc!=3 || (strcmp(argv[1],"scan") && strcmp(argv[1],"join"))) {
        emit(@{@"ok":@NO,@"error":@"Usage: wifi scan|join SSID"});return 2;
    }
    NSString *ssid=[NSString stringWithUTF8String:argv[2]];
    CWInterface *interface=[[CWWiFiClient sharedWiFiClient] interface];
    if(!interface){emit(@{@"ok":@NO,@"error":@"No Wi-Fi interface"});return 3;}
    NSError *error=nil;
    NSSet<CWNetwork *> *matches=[interface scanForNetworksWithName:ssid error:&error];
    if(error){emit(@{@"ok":@NO,@"stage":@"scan",@"error":error.localizedDescription,@"domain":error.domain,@"code":@(error.code)});return 4;}
    NSMutableArray *networks=[NSMutableArray array];
    for(CWNetwork *n in matches)[networks addObject:@{@"ssid":n.ssid ?: [NSNull null],@"bssid":n.bssid ?: [NSNull null],@"rssi":@(n.rssiValue),@"open":@([n supportsSecurity:kCWSecurityNone])}];
    if(!strcmp(argv[1],"scan")){emit(@{@"ok":@YES,@"target":ssid,@"matches":networks});return 0;}
    if(matches.count!=1){emit(@{@"ok":@NO,@"stage":@"selection",@"target":ssid,@"count":@(matches.count),@"error":@"Expected exactly one matching robot AP; no association attempted"});return 5;}
    CWNetwork *network=matches.anyObject;
    if(![network supportsSecurity:kCWSecurityNone]){emit(@{@"ok":@NO,@"error":@"Robot AP is encrypted; no password guessed"});return 6;}
    BOOL joined=[interface associateToNetwork:network password:nil error:&error];
    emit(@{@"ok":@(joined),@"stage":@"association",@"target":ssid,@"ssidVisible":@(network.ssid!=nil),@"error":error.localizedDescription ?: @"",@"domain":error.domain ?: @"",@"code":@(error.code)});
    return joined?0:7;
} }
