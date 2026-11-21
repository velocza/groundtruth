"""Stop only the GroundTruth local application using its loopback endpoint."""
import urllib.request
import urllib.error

if __name__ == '__main__':
    origin = 'http://127.0.0.1:8765'
    request = urllib.request.Request(origin+'/api/shutdown', data=b'',
                                     headers={'Origin': origin}, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            print('GroundTruth local simulation is stopping.' if response.status == 200 else 'Stop failed.')
    except urllib.error.URLError as exc:
        print('GroundTruth is not reachable: '+str(exc))
